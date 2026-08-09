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

export interface BunLoggerOptions extends LoggerOptions {
  flushOnShutdown?: boolean;
  shutdownTimeoutMillis?: number;
}

type BunRuntime = {
  version?: string;
  revision?: string;
};

type BunProcessListener = (...values: never[]) => void;
type BunProcess = {
  pid: number;
  on(event: string, listener: BunProcessListener): void;
  off(event: string, listener: BunProcessListener): void;
  kill(pid: number, signal: 'SIGINT' | 'SIGTERM'): boolean;
};

const bunLoggers = new Set<BunLogger>();
let bunHandlersInstalled = false;
let bunShutdownInProgress = false;

function getBunProcess(): BunProcess | undefined {
  if (!(globalThis as { Bun?: BunRuntime }).Bun) {
    return undefined;
  }
  return (globalThis as { process?: BunProcess }).process;
}

async function flushBunLoggers(): Promise<void> {
  await Promise.allSettled(
    Array.from(bunLoggers, async (logger) =>
      logger.flushOnExit({ timeoutMillis: logger.shutdownTimeoutMillis }),
    ),
  );
}

const handleBunBeforeExit = (): void => {
  getBunProcess()?.off('beforeExit', handleBunBeforeExit);
  void flushBunLoggers();
};

async function handleBunSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (bunShutdownInProgress) {
    return;
  }
  bunShutdownInProgress = true;
  await flushBunLoggers();
  removeBunHandlers();
  const bunProcess = getBunProcess();
  bunProcess?.kill(bunProcess.pid, signal);
}

const handleBunSigint = (): void => void handleBunSignal('SIGINT');
const handleBunSigterm = (): void => void handleBunSignal('SIGTERM');

function installBunHandlers(): void {
  const bunProcess = getBunProcess();
  if (!bunProcess || bunHandlersInstalled) {
    return;
  }
  bunHandlersInstalled = true;
  bunProcess.on('beforeExit', handleBunBeforeExit);
  bunProcess.on('SIGINT', handleBunSigint);
  bunProcess.on('SIGTERM', handleBunSigterm);
}

function removeBunHandlers(): void {
  const bunProcess = getBunProcess();
  if (!bunProcess || !bunHandlersInstalled) {
    return;
  }
  bunHandlersInstalled = false;
  bunProcess.off('beforeExit', handleBunBeforeExit);
  bunProcess.off('SIGINT', handleBunSigint);
  bunProcess.off('SIGTERM', handleBunSigterm);
}

function registerBunLogger(logger: BunLogger): void {
  bunLoggers.add(logger);
  installBunHandlers();
}

function unregisterBunLogger(logger: BunLogger): void {
  bunLoggers.delete(logger);
  if (bunLoggers.size === 0) {
    removeBunHandlers();
  }
}

export class BunLogger extends BaseLogger {
  protected declare readonly options: Readonly<BunLoggerOptions>;

  private lifecycleRegistered = false;

  constructor(options: BunLoggerOptions = {}) {
    super(options, 'bun');
    if (options.flushOnShutdown !== false) {
      registerBunLogger(this);
      this.lifecycleRegistered = true;
    }
  }

  get shutdownTimeoutMillis(): number {
    return this.options.shutdownTimeoutMillis ?? 4_000;
  }

  override getRuntimeFields(): LogFields {
    const bun = (globalThis as { Bun?: BunRuntime }).Bun;
    return {
      ...(bun?.version ? { bunVersion: bun.version } : {}),
      ...(bun?.revision ? { bunRevision: bun.revision } : {}),
    };
  }

  override anew(options: BunLoggerOptions = {}): BunLogger {
    return new BunLogger({
      ...this.options,
      ...options,
      appName: options.appName || this.appName,
      fields: { ...this.fields, ...options.fields },
      loggedInUser: { ...this.getCurrentUser(), ...options.loggedInUser },
    });
  }

  override async close(options: FlushOptions = {}): Promise<void> {
    if (this.lifecycleRegistered) {
      unregisterBunLogger(this);
      this.lifecycleRegistered = false;
    }
    await super.close(options);
  }
}

export function createBunLogger(options: BunLoggerOptions = {}): BunLogger {
  return new BunLogger(options);
}

export const bunLogger = createBunLogger();
export { bunLogger as logger };
export default bunLogger;
