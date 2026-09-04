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

export interface DenoLoggerOptions extends LoggerOptions {
  flushOnUnload?: boolean;
  shutdownTimeoutMillis?: number;
}

type DenoRuntime = {
  pid?: number;
  version?: {
    deno?: string;
    v8?: string;
    typescript?: string;
  };
  addSignalListener?: (signal: string, handler: () => void) => void;
  removeSignalListener?: (signal: string, handler: () => void) => void;
  exit?: (code?: number) => never;
};

/**
 * `unload` does not fire when a process is signalled, and a signal is how a
 * container stops. Without these, every record buffered by a Deno service is
 * lost on every ordinary deployment.
 */
const DENO_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

export class DenoLogger extends BaseLogger {
  protected declare readonly options: Readonly<DenoLoggerOptions>;

  private removeUnloadHandler: (() => void) | null = null;
  private shutdownInProgress = false;

  constructor(options: DenoLoggerOptions = {}) {
    super(options, 'deno');
    if (options.flushOnUnload === false) {
      return;
    }

    const timeoutMillis = options.shutdownTimeoutMillis ?? 2_000;
    const removers: Array<() => void> = [];

    if (typeof globalThis.addEventListener === 'function') {
      const drain = (): void => {
        void this.flushOnExit({ timeoutMillis });
      };
      for (const event of ['unload', 'beforeunload']) {
        globalThis.addEventListener(event, drain);
        removers.push(() => globalThis.removeEventListener(event, drain));
      }
    }

    const deno = (globalThis as { Deno?: DenoRuntime }).Deno;
    if (typeof deno?.addSignalListener === 'function') {
      for (const signal of DENO_SIGNALS) {
        const onSignal = (): void => {
          if (this.shutdownInProgress) {
            // Second signal: stop waiting on the drain and let the process go.
            this.removeUnloadHandler?.();
            deno.exit?.(130);
            return;
          }
          this.shutdownInProgress = true;
          void this.flushOnExit({ timeoutMillis }).finally(() => {
            this.removeUnloadHandler?.();
            deno.exit?.(0);
          });
        };
        try {
          deno.addSignalListener(signal, onSignal);
          removers.push(() => deno.removeSignalListener?.(signal, onSignal));
        } catch {
          // Deno rejects SIGHUP on Windows and refuses any signal listener
          // without --allow-run in some sandboxes; the unload path still holds.
        }
      }
    }

    if (removers.length > 0) {
      this.removeUnloadHandler = () => {
        for (const remove of removers) {
          try {
            remove();
          } catch {
            // Detaching is best-effort during teardown.
          }
        }
        this.removeUnloadHandler = null;
      };
    }
  }

  override getRuntimeFields(): LogFields {
    const deno = (globalThis as { Deno?: DenoRuntime }).Deno;
    return {
      ...(deno?.pid !== undefined ? { pid: deno.pid } : {}),
      ...(deno?.version?.deno ? { denoVersion: deno.version.deno } : {}),
      ...(deno?.version?.v8 ? { v8Version: deno.version.v8 } : {}),
      ...(deno?.version?.typescript ? { typescriptVersion: deno.version.typescript } : {}),
    };
  }

  override anew(options: DenoLoggerOptions = {}): DenoLogger {
    return new DenoLogger({
      ...this.options,
      ...options,
      appName: options.appName || this.appName,
      fields: { ...this.fields, ...options.fields },
      loggedInUser: { ...this.getCurrentUser(), ...options.loggedInUser },
    });
  }

  override async close(options: FlushOptions = {}): Promise<void> {
    this.removeUnloadHandler?.();
    this.removeUnloadHandler = null;
    await super.close(options);
  }
}

export function createDenoLogger(options: DenoLoggerOptions = {}): DenoLogger {
  return new DenoLogger(options);
}

export const denoLogger = createDenoLogger();
export { denoLogger as logger };
export default denoLogger;
