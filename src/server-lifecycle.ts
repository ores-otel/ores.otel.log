/**
 * Explicit Node.js server shutdown coordination.
 *
 * This module never installs handlers at import time. Call
 * `installNodeServerShutdown()` once from the application entrypoint and use a
 * NodeLogger configured with `{ flushOnShutdown: false }` so one coordinator
 * owns process signals, server draining, connection forcing, and log flushing.
 */

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';
export type ShutdownCause =
  | ShutdownSignal
  | 'stdin-eof'
  | 'timeout'
  | 'programmatic';
export type ShutdownPhase = 'running' | 'draining' | 'forced' | 'closed';
export type ShutdownAction = 'begin-graceful' | 'force' | 'ignore';
export type ShutdownStateEvent = 'trigger' | 'force-now' | 'mark-closed';
export type ShutdownModelAction = ShutdownAction | 'close';

export interface ShutdownStateTransition {
  readonly phase: ShutdownPhase;
  readonly action: ShutdownModelAction;
}

type ShutdownTransitionKey = `${ShutdownPhase}:${ShutdownStateEvent}`;

/** Non-identity cases in the total shutdown relation. Unlisted pairs ignore. */
const SHUTDOWN_TRANSITIONS: Readonly<
  Partial<Record<ShutdownTransitionKey, ShutdownStateTransition>>
> = Object.freeze({
  'running:trigger': Object.freeze({
    phase: 'draining',
    action: 'begin-graceful',
  }),
  'draining:trigger': Object.freeze({ phase: 'forced', action: 'force' }),
  'running:force-now': Object.freeze({ phase: 'forced', action: 'force' }),
  'draining:force-now': Object.freeze({ phase: 'forced', action: 'force' }),
  'draining:mark-closed': Object.freeze({ phase: 'closed', action: 'close' }),
});

export interface ShutdownEvent {
  phase: ShutdownPhase;
  action: ShutdownAction;
  cause: ShutdownCause;
  interactive: boolean;
  /** Counts operating-system SIGINT/SIGTERM events only. */
  signalCount: number;
  message: string;
  error?: unknown;
}

export interface ShutdownResult {
  phase: 'forced' | 'closed';
  cause: ShutdownCause;
  startedAt: number;
  finishedAt: number;
  errors: readonly unknown[];
}

/** Structural subset shared by node:http, node:https, and compatible servers. */
export interface GracefulNodeServer {
  close(callback: (error?: Error) => void): unknown;
  /** Node 18.2+: optional compatibility cleanup for idle keep-alive sockets. */
  closeIdleConnections?(): void;
  /** Node 18.2+: forcefully destroys active HTTP(S) connections. */
  closeAllConnections?(): void;
}

export interface ShutdownProcessLike {
  exitCode?: number;
  on(event: ShutdownSignal, listener: () => void): void;
  off(event: ShutdownSignal, listener: () => void): void;
}

export interface ShutdownStdinLike {
  isTTY?: boolean;
  readableFlowing?: boolean | null;
  on(event: 'end', listener: () => void): void;
  off(event: 'end', listener: () => void): void;
  resume?(): void;
  pause?(): void;
}

export interface NodeServerShutdownOptions {
  servers: GracefulNodeServer | readonly GracefulNodeServer[];
  /** Maximum graceful drain time before forceful connection closure. Default 15s. */
  timeoutMillis?: number;
  /** Maximum time to await force hooks/log flushing before resolving. Default 5s. */
  forceTimeoutMillis?: number;
  /** Overrides stdin TTY detection. */
  interactive?: boolean;
  /**
   * Permit terminal EOF (Ctrl-D) to replace the second Ctrl-C. The listener is
   * armed only after the first interactive SIGINT, so installing the lifecycle
   * controller never consumes application stdin. Defaults to true for a TTY.
   */
  watchStdinEof?: boolean;
  process?: ShutdownProcessLike;
  stdin?: ShutdownStdinLike;
  /** Structured lifecycle logging hook. It is fail-open and never blocks shutdown. */
  onLog?: (event: ShutdownEvent) => void | Promise<void>;
  /** Runs before listeners begin draining, e.g. readiness withdrawal. */
  beforeGraceful?: (cause: ShutdownCause) => void | Promise<void>;
  /** Flush application logs/telemetry after active requests have drained. */
  flush?: (cause: ShutdownCause) => void | Promise<void>;
  /** Runs after graceful server closure and flushing. */
  afterGraceful?: (cause: ShutdownCause) => void | Promise<void>;
  /**
   * Force-closes resources not covered by closeAllConnections, such as
   * WebSockets, HTTP/2 sessions, queues, or application-owned task groups.
   */
  force?: (cause: ShutdownCause) => void | Promise<void>;
  /** Process exitCode set after completion. Default 0; the process is never exited directly. */
  exitCode?: number;
  /** Monotonic-ish clock injection for deterministic tests. */
  now?: () => number;
}

export interface NodeServerShutdownController {
  readonly phase: ShutdownPhase;
  readonly done: Promise<ShutdownResult>;
  requestGraceful(cause?: ShutdownCause): void;
  force(cause?: ShutdownCause): void;
  dispose(): void;
}

export interface ShutdownLogRecordLike {
  addFields(fields: Readonly<Record<string, unknown>>): ShutdownLogRecordLike;
  addTags(...tags: string[]): ShutdownLogRecordLike;
  send(): unknown;
}

/** Structural subset implemented by BaseLogger/NodeLogger. */
export interface ShutdownLoggerLike {
  info(...values: unknown[]): ShutdownLogRecordLike;
  warn(...values: unknown[]): ShutdownLogRecordLike;
  error(...values: unknown[]): ShutdownLogRecordLike;
}

/**
 * Adapts lifecycle events to next-loggers without importing or installing a
 * logger singleton. Delivery is best-effort: logging can never block shutdown.
 */
export function createNodeLoggerShutdownSink(
  logger: ShutdownLoggerLike,
): (event: ShutdownEvent) => void {
  return (event) => {
    try {
      const record =
        event.error !== undefined
          ? logger.error(event.message, event.error)
          : event.phase === 'forced'
            ? logger.warn(event.message)
            : logger.info(event.message);
      const sent = record
        .addFields({
          'shutdown.phase': event.phase,
          'shutdown.action': event.action,
          'shutdown.cause': event.cause,
          'shutdown.interactive': event.interactive,
          'shutdown.signal_count': event.signalCount,
        })
        .addTags('shutdown', event.phase)
        .send();
      if (
        typeof sent === 'object' &&
        sent !== null &&
        'then' in sent &&
        typeof (sent as { then?: unknown }).then === 'function'
      ) {
        void Promise.resolve(sent).catch(() => undefined);
      }
    } catch {
      // Best-effort observability must not interfere with process termination.
    }
  };
}

function getGlobalProcess(): ShutdownProcessLike | undefined {
  return (globalThis as { process?: ShutdownProcessLike }).process;
}

function getGlobalStdin(): ShutdownStdinLike | undefined {
  return (globalThis as { process?: { stdin?: ShutdownStdinLike } }).process
    ?.stdin;
}

function asServers(
  value: GracefulNodeServer | readonly GracefulNodeServer[],
): readonly GracefulNodeServer[] {
  return Array.isArray(value) ? value : [value as GracefulNodeServer];
}

function isAlreadyClosedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_SERVER_NOT_RUNNING'
  );
}

function closeGracefully(server: GracefulNodeServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error && !isAlreadyClosedError(error)) reject(error);
      else resolve();
    };

    try {
      const returned = server.close(settle);
      if (
        typeof returned === 'object' &&
        returned !== null &&
        'then' in returned &&
        typeof (returned as { then?: unknown }).then === 'function'
      ) {
        void Promise.resolve(returned).then(() => settle(), (error) => {
          if (error instanceof Error) settle(error);
          else {
            settled = true;
            reject(error);
          }
        });
      }
      // Invoke this after close() to avoid an accept/idle-close race.
      server.closeIdleConnections?.();
    } catch (error) {
      if (isAlreadyClosedError(error)) settle();
      else {
        settled = true;
        reject(error);
      }
    }
  });
}

function defaultLog(event: ShutdownEvent): void {
  const line = `[shutdown:${event.phase}] ${event.message}`;
  if (event.error !== undefined) console.error(line, event.error);
  else if (event.phase === 'forced') console.warn(line);
  else console.info(line);
}

/**
 * Installs one coordinated shutdown owner.
 *
 * Interactive semantics:
 * - the first SIGINT begins graceful drain and only then arms terminal EOF;
 * - a second SIGINT, another termination signal, or armed Ctrl-D forces close;
 * - SIGTERM begins graceful drain but does not arm or read stdin.
 *
 * Non-interactive semantics:
 * - one SIGINT/SIGTERM begins graceful drain; stdin is never read;
 * - a second signal or the deadline escalates to forceful closure.
 */
export function installNodeServerShutdown(
  options: NodeServerShutdownOptions,
): NodeServerShutdownController {
  const servers = asServers(options.servers);
  if (servers.length === 0) {
    throw new TypeError('installNodeServerShutdown requires at least one server');
  }

  const runtimeProcess = options.process ?? getGlobalProcess();
  const runtimeStdin = options.stdin ?? getGlobalStdin();
  const interactive = options.interactive ?? runtimeStdin?.isTTY === true;
  const watchStdinEof = options.watchStdinEof ?? interactive;
  const timeoutMillis = Math.max(1, Math.trunc(options.timeoutMillis ?? 15_000));
  const forceTimeoutMillis = Math.max(
    1,
    Math.trunc(options.forceTimeoutMillis ?? Math.min(timeoutMillis, 5_000)),
  );
  const exitCode = Math.trunc(options.exitCode ?? 0);
  const now = options.now ?? Date.now;
  const logger = options.onLog ?? defaultLog;
  const errors: unknown[] = [];

  let phase: ShutdownPhase = 'running';
  let signalCount = 0;
  let startedAt = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let flushPromise: Promise<void> | undefined;
  let disposed = false;
  let resolved = false;
  let eofArmed = false;
  let resumedStdin = false;

  let resolveDone!: (result: ShutdownResult) => void;
  const done = new Promise<ShutdownResult>((resolve) => {
    resolveDone = resolve;
  });

  const emit = (
    action: ShutdownAction,
    cause: ShutdownCause,
    message: string,
    error?: unknown,
  ): void => {
    const event: ShutdownEvent = {
      phase,
      action,
      cause,
      interactive,
      signalCount,
      message,
      ...(error === undefined ? {} : { error }),
    };
    try {
      const result = logger(event);
      if (
        typeof result === 'object' &&
        result !== null &&
        'then' in result &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Logging must never prevent server shutdown.
    }
  };

  const capture = async (
    operation: string,
    cause: ShutdownCause,
    callback: (() => void | Promise<void>) | undefined,
  ): Promise<void> => {
    if (!callback) return;
    try {
      await callback();
    } catch (error) {
      errors.push(error);
      emit('ignore', cause, `${operation} failed; shutdown continues`, error);
    }
  };

  const flushOnce = (cause: ShutdownCause): Promise<void> => {
    flushPromise ??= capture(
      'Telemetry flush',
      cause,
      options.flush && (() => options.flush?.(cause)),
    );
    return flushPromise;
  };

  const waitBounded = async (
    operation: string,
    cause: ShutdownCause,
    promise: Promise<void>,
    limitMillis: number,
  ): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${operation} exceeded ${limitMillis}ms`)),
            limitMillis,
          );
        }),
      ]);
    } catch (error) {
      errors.push(error);
      emit(
        'ignore',
        cause,
        `${operation} did not finish before the force deadline`,
        error,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const onStdinEnd = (): void => {
    // EOF is not a signal and is valid only after the first interactive SIGINT.
    if (eofArmed && phase === 'draining') force('stdin-eof');
  };

  const armInteractiveEof = (): void => {
    if (
      eofArmed ||
      !watchStdinEof ||
      !interactive ||
      runtimeStdin === undefined
    ) {
      return;
    }
    eofArmed = true;
    runtimeStdin.on('end', onStdinEnd);
    if (runtimeStdin.readableFlowing !== true && runtimeStdin.resume) {
      runtimeStdin.resume();
      resumedStdin = true;
    }
  };

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    runtimeProcess?.off('SIGINT', onSigint);
    runtimeProcess?.off('SIGTERM', onSigterm);
    if (eofArmed) runtimeStdin?.off('end', onStdinEnd);
    if (
      resumedStdin &&
      runtimeStdin?.readableFlowing === true &&
      runtimeStdin.pause
    ) {
      runtimeStdin.pause();
    }
  };

  const finish = (finalPhase: 'forced' | 'closed', cause: ShutdownCause): void => {
    if (resolved) return;
    resolved = true;
    phase = finalPhase;
    cleanup();
    if (runtimeProcess) runtimeProcess.exitCode = exitCode;
    const finishedAt = now();
    emit(
      finalPhase === 'forced' ? 'force' : 'ignore',
      cause,
      finalPhase === 'forced'
        ? 'Forceful shutdown completed'
        : 'Graceful shutdown completed',
    );
    resolveDone({
      phase: finalPhase,
      cause,
      startedAt,
      finishedAt,
      errors: Object.freeze([...errors]),
    });
  };

  const force = (cause: ShutdownCause = 'programmatic'): void => {
    if (phase === 'forced' || phase === 'closed') return;
    if (startedAt === 0) startedAt = now();
    phase = 'forced';
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    emit(
      'force',
      cause,
      'Forcing shutdown: active HTTP connections and application resources will be closed',
    );

    for (const server of servers) {
      try {
        server.close(() => undefined);
      } catch (error) {
        if (!isAlreadyClosedError(error)) {
          errors.push(error);
          emit(
            'ignore',
            cause,
            'Server listener close failed during force escalation',
            error,
          );
        }
      }
      try {
        server.closeAllConnections?.();
      } catch (error) {
        errors.push(error);
        emit(
          'ignore',
          cause,
          'Force-closing active server connections failed',
          error,
        );
      }
    }

    void (async () => {
      await waitBounded(
        'Application force hook',
        cause,
        capture(
          'Application force hook',
          cause,
          options.force && (() => options.force?.(cause)),
        ),
        forceTimeoutMillis,
      );
      await waitBounded(
        'Telemetry flush',
        cause,
        flushOnce(cause),
        forceTimeoutMillis,
      );
      finish('forced', cause);
    })();
  };

  const requestGraceful = (cause: ShutdownCause = 'programmatic'): void => {
    if (phase === 'draining') {
      force(cause);
      return;
    }
    if (phase !== 'running') return;

    startedAt = now();
    phase = 'draining';
    const interactiveSigint = interactive && cause === 'SIGINT';
    emit(
      'begin-graceful',
      cause,
      interactiveSigint
        ? 'Graceful shutdown requested; draining active work. Press Ctrl-C again or Ctrl-D to force.'
        : 'Graceful shutdown requested; draining active work.',
    );
    if (interactiveSigint) armInteractiveEof();

    timeout = setTimeout(() => force('timeout'), timeoutMillis);

    void (async () => {
      await capture(
        'Pre-shutdown hook',
        cause,
        options.beforeGraceful && (() => options.beforeGraceful?.(cause)),
      );
      if (phase !== 'draining') return;

      const closeResults = await Promise.allSettled(servers.map(closeGracefully));
      let closeFailed = false;
      for (const result of closeResults) {
        if (result.status === 'rejected') {
          closeFailed = true;
          errors.push(result.reason);
          emit('ignore', cause, 'A server failed to close gracefully', result.reason);
        }
      }
      if (closeFailed && phase === 'draining') {
        force(cause);
        return;
      }
      if (phase !== 'draining') return;

      await flushOnce(cause);
      if (phase !== 'draining') return;
      await capture(
        'Post-shutdown hook',
        cause,
        options.afterGraceful && (() => options.afterGraceful?.(cause)),
      );
      if (phase === 'draining') finish('closed', cause);
    })();
  };

  const onSigint = (): void => {
    signalCount += 1;
    if (phase === 'running') requestGraceful('SIGINT');
    else if (phase === 'draining') force('SIGINT');
  };

  const onSigterm = (): void => {
    signalCount += 1;
    if (phase === 'running') requestGraceful('SIGTERM');
    else if (phase === 'draining') force('SIGTERM');
  };

  runtimeProcess?.on('SIGINT', onSigint);
  runtimeProcess?.on('SIGTERM', onSigterm);
  // Deliberately do not subscribe to or resume stdin here. EOF becomes a force
  // input only after the first interactive SIGINT has started draining.

  return {
    get phase() {
      return phase;
    },
    done,
    requestGraceful,
    force,
    dispose: cleanup,
  };
}

/** Pure transition helper used by non-Node adapters and conformance tests. */
export function transitionShutdownState(
  phase: ShutdownPhase,
  event: ShutdownStateEvent,
): ShutdownStateTransition {
  return (
    SHUTDOWN_TRANSITIONS[`${phase}:${event}`]
    ?? Object.freeze({ phase, action: 'ignore' as const })
  );
}

export function nextShutdownAction(
  phase: ShutdownPhase,
  _cause: ShutdownCause,
): ShutdownAction {
  const action = transitionShutdownState(phase, 'trigger').action;
  return action === 'close' ? 'ignore' : action;
}
