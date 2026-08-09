import {
  setLogContextProvider,
  type LogContext,
  type LogContextProvider,
  type LogUser,
} from './base-logger.js';

/**
 * Structural view of the underlying AsyncLocalStorage: keeps the emitted
 * declaration files free of node:async_hooks so consumers without @types/node
 * (and with skipLibCheck: false) still typecheck.
 */
export interface LogContextStorage {
  getStore(): LogContext | undefined;
  run<R>(store: LogContext, callback: () => R): R;
}

/** Constructor shape shared by node:async_hooks and workerd's global AsyncLocalStorage. */
export type AsyncLocalStorageConstructor = new () => LogContextStorage;

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Single-frame fallback for runtimes with no async context tracking (browsers,
 * and workerd without the nodejs_als/nodejs_compat flag).
 *
 * It restores the previous frame when the callback — or the promise the
 * callback returns — settles. That is correct for strictly sequential work but
 * CANNOT isolate concurrent async flows: two overlapping runWithLogContext()
 * calls will see each other's context. Check isAsyncContextTracked() before
 * relying on per-request isolation, or attach a real store via
 * logger.setALS()/setLogContextProvider().
 */
export class SingleFrameLogContextStorage implements LogContextStorage {
  private current: LogContext | undefined;

  getStore(): LogContext | undefined {
    return this.current;
  }

  run<R>(store: LogContext, callback: () => R): R {
    const previous = this.current;
    this.current = store;
    let result: R;
    try {
      result = callback();
    } catch (error) {
      this.current = previous;
      throw error;
    }
    if (isThenable(result)) {
      return (result as Promise<unknown>).finally(() => {
        this.current = previous;
      }) as R;
    }
    this.current = previous;
    return result;
  }
}

/**
 * workerd exposes AsyncLocalStorage as a global when the nodejs_als (or
 * nodejs_compat) compatibility flag is set. Reading it off globalThis avoids a
 * static `node:async_hooks` import, which throws at module-evaluation time when
 * the flag is absent — a crash the fallback below is meant to prevent.
 */
export function getGlobalAsyncLocalStorage(): AsyncLocalStorageConstructor | undefined {
  const candidate = (globalThis as { AsyncLocalStorage?: AsyncLocalStorageConstructor })
    .AsyncLocalStorage;
  return typeof candidate === 'function' ? candidate : undefined;
}

/**
 * Shallow-merges a patch into a context frame: objects merge, arrays append and
 * dedupe. Shared by every context entry point so the merge semantics cannot
 * drift between runtimes.
 */
export function mergeLogContext(current: LogContext, patch: LogContext): void {
  if (patch.loggedInUser) {
    current.loggedInUser = { ...current.loggedInUser, ...patch.loggedInUser };
  }
  if (patch.users && patch.users.length > 0) {
    current.users = [...(current.users ?? []), ...patch.users];
  }
  if (patch.fields) {
    current.fields = { ...current.fields, ...patch.fields };
  }
  const existingTraces = current.traceIds ?? (current.traceId ? [current.traceId] : []);
  if (patch.traceId) {
    current.traceId = patch.traceId;
    current.traceIds = Array.from(new Set([...existingTraces, patch.traceId]));
  }
  if (patch.traceIds && patch.traceIds.length > 0) {
    current.traceIds = Array.from(
      new Set([...(current.traceIds ?? existingTraces), ...patch.traceIds]),
    );
  }
  if (patch.routineId) {
    current.routineId = patch.routineId;
  }
  if (patch.tags && patch.tags.length > 0) {
    current.tags = Array.from(new Set([...(current.tags ?? []), ...patch.tags]));
  }
}

/** The public surface each runtime's context entry point re-exports. */
export interface LogContextApi {
  logContextStorage: LogContextStorage;
  isAsyncContextTracked(): boolean;
  runWithLogContext<T>(context: LogContext, callback: () => T): T;
  getLogContext(): LogContext | undefined;
  updateLogContext(patch: LogContext): boolean;
  setContextLoggedInUser(user: LogUser): boolean;
  logContextProvider: LogContextProvider;
  installLogContextProvider(): () => void;
}

/** Builds the context API over a given storage implementation. */
export function createLogContextApi(
  logContextStorage: LogContextStorage,
  asyncTracked: boolean,
): LogContextApi {
  const logContextProvider: LogContextProvider = () => logContextStorage.getStore();

  return {
    logContextStorage,
    isAsyncContextTracked: () => asyncTracked,
    runWithLogContext: (context, callback) => logContextStorage.run({ ...context }, callback),
    getLogContext: () => logContextStorage.getStore(),
    updateLogContext: (patch) => {
      const current = logContextStorage.getStore();
      if (!current) {
        return false;
      }
      mergeLogContext(current, patch);
      return true;
    },
    setContextLoggedInUser: (user) => {
      const current = logContextStorage.getStore();
      if (!current) {
        return false;
      }
      mergeLogContext(current, { loggedInUser: user });
      return true;
    },
    logContextProvider,
    installLogContextProvider: () => {
      const previous = setLogContextProvider(logContextProvider);
      return () => {
        setLogContextProvider(previous);
      };
    },
  };
}
