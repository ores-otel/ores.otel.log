import {
  BaseLogger,
  type FlushOptions,
  type LogFields,
  type LoggerOptions,
} from './base-logger.js';

// Namespaced re-export: the whole shared surface is reachable as `base.*` from
// every runtime entrypoint, without flattening it into this module's own
// exports (so runtime-specific names can never collide with shared ones).
// A namespace re-export carries types as well as values, so `base.LogLevel`
// works in type position and `base.createLogger` in value position.
export * as base from './base-logger.js';

// r2g phase-S loads the package root and requires this exact flat export.
// Keep the rest of the shared API namespaced; this one compatibility hook is
// deliberately promoted so the packed artifact can be certified directly.
export { r2gSmokeTest } from './base-logger.js';

type ProcessListener = (...values: never[]) => void;

declare const process: {
  pid: number;
  version: string;
  platform: string;
  arch: string;
  env: Record<string, string | undefined>;
  on(event: string, listener: ProcessListener): void;
  off(event: string, listener: ProcessListener): void;
  kill(pid: number, signal: string): boolean;
};

export interface NodeLoggerOptions extends LoggerOptions {
  captureProcessErrors?: boolean;
  /** @deprecated Use flushOnShutdown. */
  flushOnBeforeExit?: boolean;
  flushOnShutdown?: boolean;
  shutdownTimeoutMillis?: number;
}

const registeredNodeLoggers = new Set<NodeLogger>();
let lifecycleHandlersInstalled = false;
let shutdownInProgress = false;
let beforeExitDrainInProgress = false;

async function flushRegisteredNodeLoggers(): Promise<void> {
  await Promise.allSettled(
    Array.from(registeredNodeLoggers, async (logger) =>
      logger.flushOnExit({ timeoutMillis: logger.shutdownTimeoutMillis }),
    ),
  );
}

/**
 * Signals the loggers attach to. SIGHUP and SIGQUIT are included because a
 * terminal hangup and a container stop are both ordinary ways for a process to
 * end, and records buffered at that moment are worth the same as any other.
 */
const LIFECYCLE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
type LifecycleSignal = (typeof LIFECYCLE_SIGNALS)[number];

const handleBeforeExit = (): void => {
  if (beforeExitDrainInProgress || shutdownInProgress) {
    return;
  }
  // Detached for the duration of the drain, because flushing keeps the event
  // loop alive and would otherwise re-enter this handler. It is re-attached
  // below: a beforeExit drain can revive the loop, and the next quiescence
  // deserves a flush just as much as this one did.
  process.off('beforeExit', handleBeforeExit);
  beforeExitDrainInProgress = true;
  void flushRegisteredNodeLoggers().finally(() => {
    beforeExitDrainInProgress = false;
    if (lifecycleHandlersInstalled && !shutdownInProgress) {
      process.on('beforeExit', handleBeforeExit);
    }
  });
};

async function handleSignal(signal: LifecycleSignal): Promise<void> {
  if (shutdownInProgress) {
    // A second Ctrl-C means the operator is done waiting. Because attaching a
    // listener overrode the kernel default, doing nothing here would make the
    // process unkillable for as long as a wedged transport takes to give up.
    removeLifecycleHandlers();
    process.kill(process.pid, signal);
    return;
  }
  shutdownInProgress = true;
  try {
    await flushRegisteredNodeLoggers();
  } finally {
    removeLifecycleHandlers();
    process.kill(process.pid, signal);
  }
}

const signalHandlers = new Map<LifecycleSignal, () => void>(
  LIFECYCLE_SIGNALS.map((signal) => [signal, () => void handleSignal(signal)]),
);

function installLifecycleHandlers(): void {
  if (lifecycleHandlersInstalled) {
    return;
  }
  lifecycleHandlersInstalled = true;
  process.on('beforeExit', handleBeforeExit);
  for (const [signal, handler] of signalHandlers) {
    try {
      process.on(signal, handler);
    } catch {
      // Windows has no SIGQUIT and rejects some POSIX names outright.
    }
  }
}

function removeLifecycleHandlers(): void {
  if (!lifecycleHandlersInstalled) {
    return;
  }
  lifecycleHandlersInstalled = false;
  process.off('beforeExit', handleBeforeExit);
  for (const [signal, handler] of signalHandlers) {
    try {
      process.off(signal, handler);
    } catch {
      // Mirrors the install guard above.
    }
  }
}

function registerNodeLogger(logger: NodeLogger): void {
  registeredNodeLoggers.add(logger);
  installLifecycleHandlers();
}

function unregisterNodeLogger(logger: NodeLogger): void {
  registeredNodeLoggers.delete(logger);
  if (registeredNodeLoggers.size === 0) {
    removeLifecycleHandlers();
  }
}

export class NodeLogger extends BaseLogger {
  protected declare readonly options: Readonly<NodeLoggerOptions>;

  private removeErrorHandlers: (() => void) | null = null;
  private lifecycleRegistered = false;

  constructor(options: NodeLoggerOptions = {}) {
    super(options, 'node');
    const flushOnShutdown = options.flushOnShutdown ?? options.flushOnBeforeExit ?? true;
    if (flushOnShutdown) {
      registerNodeLogger(this);
      this.lifecycleRegistered = true;
    }
    if (options.captureProcessErrors) {
      this.installErrorHandlers();
    }
  }

  get shutdownTimeoutMillis(): number {
    return this.options.shutdownTimeoutMillis ?? 4_000;
  }

  override getRuntimeFields(): LogFields {
    return {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      ...(process.env.HOSTNAME ? { hostname: process.env.HOSTNAME } : {}),
    };
  }

  override anew(options: NodeLoggerOptions = {}): NodeLogger {
    return new NodeLogger({
      ...this.options,
      ...options,
      appName: options.appName || this.appName,
      fields: { ...this.fields, ...options.fields },
      loggedInUser: { ...this.getCurrentUser(), ...options.loggedInUser },
    });
  }

  installProcessHandlers(): () => void {
    if (!this.lifecycleRegistered) {
      registerNodeLogger(this);
      this.lifecycleRegistered = true;
    }
    this.installErrorHandlers();
    return () => {
      this.removeErrorHandlers?.();
      if (this.lifecycleRegistered) {
        unregisterNodeLogger(this);
        this.lifecycleRegistered = false;
      }
    };
  }

  private installErrorHandlers(): void {
    if (this.removeErrorHandlers) {
      return;
    }

    const uncaughtException = (error: Error): void => {
      void this.fatal('Uncaught Node.js exception', error)
        .addTags('node', 'uncaught-exception')
        .captureStackTrace()
        .send();
    };
    const unhandledRejection = (reason: unknown): void => {
      void this.error('Unhandled Node.js promise rejection', reason)
        .addTags('node', 'unhandled-rejection')
        .captureStackTrace()
        .send();
    };
    process.on('uncaughtExceptionMonitor', uncaughtException);
    process.on('unhandledRejection', unhandledRejection);

    this.removeErrorHandlers = () => {
      process.off('uncaughtExceptionMonitor', uncaughtException);
      process.off('unhandledRejection', unhandledRejection);
      this.removeErrorHandlers = null;
    };
  }

  override async close(options: FlushOptions = {}): Promise<void> {
    this.removeErrorHandlers?.();
    if (this.lifecycleRegistered) {
      unregisterNodeLogger(this);
      this.lifecycleRegistered = false;
    }
    await super.close(options);
  }
}

export function createNodeLogger(options: NodeLoggerOptions = {}): NodeLogger {
  return new NodeLogger(options);
}

export const nodeLogger = createNodeLogger();
export { nodeLogger as logger };
export default nodeLogger;
