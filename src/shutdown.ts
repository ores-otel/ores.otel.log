/** Runtime-neutral two-phase shutdown coordination. */

export type ShutdownPhase = 'running' | 'draining' | 'forcing' | 'stopped';

export type ShutdownTrigger =
  | 'SIGINT'
  | 'SIGTERM'
  | 'stdin-eof'
  | 'timeout'
  | 'programmatic'
  | 'server-error'
  | 'drain-error'
  | (string & Record<never, never>);

export interface ShutdownActionContext {
  readonly trigger: ShutdownTrigger;
  readonly interactive: boolean;
  readonly attempt: number;
  readonly startedAtMillis: number;
  readonly elapsedMillis: number;
}

export interface ShutdownEvent {
  readonly phase: ShutdownPhase;
  readonly previousPhase: ShutdownPhase;
  readonly trigger: ShutdownTrigger;
  readonly interactive: boolean;
  readonly attempt: number;
  readonly elapsedMillis: number;
  readonly timestamp: string;
  readonly message: string;
  readonly error?: unknown;
}

export interface ShutdownRequestOptions {
  /** Force immediately instead of entering the drain phase. */
  readonly force?: boolean;
  /** Whether the request came from an interactive terminal. */
  readonly interactive?: boolean;
}

export interface ShutdownResult {
  readonly forced: boolean;
  readonly triggers: readonly ShutdownTrigger[];
  readonly errors: readonly unknown[];
  readonly elapsedMillis: number;
}

export interface ShutdownCoordinatorOptions {
  /** Maximum drain time before forced termination. Defaults to 30 seconds. */
  readonly gracePeriodMillis?: number;
  /** Stop accepting new work and wait for in-flight work to finish. */
  readonly drain: (context: ShutdownActionContext) => void | Promise<void>;
  /** Drop remaining work/connections. Must be idempotent. */
  readonly force: (context: ShutdownActionContext) => void | Promise<void>;
  /** Flush logs/traces after drain or force. The application owns its OTEL SDK. */
  readonly flush?: (context: ShutdownActionContext) => void | Promise<void>;
  /** Receives structured lifecycle records suitable for next-loggers/OTEL. */
  readonly onEvent?: (event: ShutdownEvent) => void | Promise<void>;
  readonly now?: () => number;
}

function messageFor(phase: ShutdownPhase, trigger: ShutdownTrigger): string {
  switch (phase) {
    case 'draining':
      return `graceful shutdown started (${trigger}); no new work will be accepted`;
    case 'forcing':
      return `forced shutdown started (${trigger}); remaining work will be terminated`;
    case 'stopped':
      return `shutdown complete (${trigger})`;
    case 'running':
      return `shutdown coordinator running (${trigger})`;
  }
}

/**
 * Coordinates exactly one graceful drain followed by an optional force phase.
 * Repeated requests are safe: the first starts draining; the next escalates.
 */
export class ShutdownCoordinator {
  readonly #options: ShutdownCoordinatorOptions;
  readonly #now: () => number;
  readonly #startedAtMillis: number;
  readonly #triggers: ShutdownTrigger[] = [];
  readonly #errors: unknown[] = [];
  readonly #observerTasks = new Set<Promise<void>>();
  readonly #completion: Promise<ShutdownResult>;

  #resolveCompletion!: (result: ShutdownResult) => void;
  #phase: ShutdownPhase = 'running';
  #attempt = 0;
  #forced = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #finished = false;

  constructor(options: ShutdownCoordinatorOptions) {
    if (typeof options.drain !== 'function' || typeof options.force !== 'function') {
      throw new TypeError('shutdown drain and force callbacks are required');
    }
    if ((options.gracePeriodMillis ?? 30_000) < 0) {
      throw new RangeError('gracePeriodMillis must be non-negative');
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#startedAtMillis = this.#now();
    this.#completion = new Promise<ShutdownResult>((resolve) => {
      this.#resolveCompletion = resolve;
    });
  }

  get phase(): ShutdownPhase {
    return this.#phase;
  }

  get attempt(): number {
    return this.#attempt;
  }

  get isStopping(): boolean {
    return this.#phase !== 'running' && this.#phase !== 'stopped';
  }

  /** Resolves when flushing has finished; it never rejects. */
  wait(): Promise<ShutdownResult> {
    return this.#completion;
  }

  /**
   * First request begins draining. A subsequent request (or force=true)
   * immediately begins forced shutdown.
   */
  request(
    trigger: ShutdownTrigger = 'programmatic',
    options: ShutdownRequestOptions = {},
  ): Promise<ShutdownResult> {
    if (this.#finished) {
      return this.#completion;
    }

    this.#attempt += 1;
    this.#triggers.push(trigger);
    const interactive = options.interactive ?? false;

    if (this.#phase === 'running' && options.force !== true) {
      this.#beginDrain(trigger, interactive);
    } else if (this.#phase === 'draining' || options.force === true) {
      this.#beginForce(trigger, interactive);
    }

    return this.#completion;
  }

  #context(trigger: ShutdownTrigger, interactive: boolean): ShutdownActionContext {
    const now = this.#now();
    return {
      trigger,
      interactive,
      attempt: this.#attempt,
      startedAtMillis: this.#startedAtMillis,
      elapsedMillis: Math.max(0, now - this.#startedAtMillis),
    };
  }

  #transition(
    next: ShutdownPhase,
    trigger: ShutdownTrigger,
    interactive: boolean,
    error?: unknown,
  ): void {
    const previousPhase = this.#phase;
    this.#phase = next;
    const context = this.#context(trigger, interactive);
    const base: ShutdownEvent = {
      phase: next,
      previousPhase,
      trigger,
      interactive,
      attempt: context.attempt,
      elapsedMillis: context.elapsedMillis,
      timestamp: new Date(this.#now()).toISOString(),
      message: messageFor(next, trigger),
    };
    const event: ShutdownEvent = error === undefined ? base : { ...base, error };
    try {
      const observed = this.#options.onEvent?.(event);
      if (observed && typeof (observed as Promise<unknown>).then === 'function') {
        let task!: Promise<void>;
        task = Promise.resolve(observed)
          .then(() => undefined, () => undefined)
          .finally(() => this.#observerTasks.delete(task));
        this.#observerTasks.add(task);
      }
    } catch {
      // Shutdown must continue even when an observer/logger fails.
    }
  }

  #beginDrain(trigger: ShutdownTrigger, interactive: boolean): void {
    if (this.#phase !== 'running') {
      return;
    }
    this.#transition('draining', trigger, interactive);

    const gracePeriodMillis = this.#options.gracePeriodMillis ?? 30_000;
    this.#timer = setTimeout(() => {
      this.request('timeout', { force: true, interactive: false });
    }, gracePeriodMillis);

    void Promise.resolve(this.#options.drain(this.#context(trigger, interactive))).then(
      () => {
        if (this.#phase === 'draining') {
          void this.#finish(trigger, interactive, false);
        }
      },
      (error: unknown) => {
        this.#errors.push(error);
        if (this.#phase === 'draining') {
          this.#transition('draining', 'drain-error', interactive, error);
          this.#beginForce('drain-error', interactive);
        }
      },
    );
  }

  #beginForce(trigger: ShutdownTrigger, interactive: boolean): void {
    if (this.#phase === 'forcing' || this.#phase === 'stopped') {
      return;
    }
    this.#forced = true;
    this.#clearTimer();
    this.#transition('forcing', trigger, interactive);
    void Promise.resolve(this.#options.force(this.#context(trigger, interactive))).then(
      () => this.#finish(trigger, interactive, true),
      (error: unknown) => {
        this.#errors.push(error);
        this.#transition('forcing', trigger, interactive, error);
        return this.#finish(trigger, interactive, true);
      },
    );
  }

  async #finish(
    trigger: ShutdownTrigger,
    interactive: boolean,
    forced: boolean,
  ): Promise<void> {
    if (this.#finished) {
      return;
    }
    // A force request won the race while drain was resolving.
    if (!forced && this.#phase !== 'draining') {
      return;
    }
    if (forced && this.#phase !== 'forcing') {
      return;
    }

    this.#clearTimer();
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#transition('stopped', trigger, interactive);
    await Promise.all([...this.#observerTasks]);

    const context = this.#context(trigger, interactive);
    try {
      await this.#options.flush?.(context);
    } catch (error) {
      this.#errors.push(error);
    }

    this.#resolveCompletion({
      forced: this.#forced,
      triggers: [...this.#triggers],
      errors: [...this.#errors],
      elapsedMillis: this.#context(trigger, interactive).elapsedMillis,
    });
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

export function createShutdownCoordinator(
  options: ShutdownCoordinatorOptions,
): ShutdownCoordinator {
  return new ShutdownCoordinator(options);
}


export interface ShutdownLogEventLike {
  addFields(fields: Record<string, unknown>): ShutdownLogEventLike;
  addError?(error: unknown): ShutdownLogEventLike;
  send(): unknown;
}

export interface ShutdownLoggerLike {
  info(...values: unknown[]): ShutdownLogEventLike;
  warn(...values: unknown[]): ShutdownLogEventLike;
  error(...values: unknown[]): ShutdownLogEventLike;
}

export function shutdownEventFields(event: ShutdownEvent): Record<string, unknown> {
  return {
    'shutdown.phase': event.phase,
    'shutdown.previous_phase': event.previousPhase,
    'shutdown.trigger': event.trigger,
    'shutdown.interactive': event.interactive,
    'shutdown.attempt': event.attempt,
    'shutdown.elapsed_ms': event.elapsedMillis,
    ...(event.error === undefined ? {} : { 'shutdown.error': String(event.error) }),
  };
}

/** Emits lifecycle records through next-loggers-compatible logger instances. */
export function createShutdownLoggerObserver(
  logger: ShutdownLoggerLike,
): (event: ShutdownEvent) => Promise<void> {
  return async (event) => {
    let entry = event.error !== undefined
      ? logger.error(event.message, event.error)
      : event.phase === 'forcing'
        ? logger.warn(event.message)
        : logger.info(event.message);
    entry = entry.addFields(shutdownEventFields(event));
    if (event.error !== undefined && entry.addError) {
      entry = entry.addError(event.error);
    }
    await entry.send();
  };
}
