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

/**
 * Synchronous-only fallback for runtimes with no async context tracking.
 *
 * The frame is restored as soon as the callback returns, even if it returns a
 * Promise. Keeping one process/global frame installed until Promise settlement
 * would let overlapping async operations observe each other's user or request
 * identifiers. Callers in these runtimes must use explicit child loggers or an
 * application-owned context provider after the first async boundary.
 */
export class SingleFrameLogContextStorage implements LogContextStorage {
  private current: LogContext | undefined;

  getStore(): LogContext | undefined {
    return this.current;
  }

  run<R>(store: LogContext, callback: () => R): R {
    const previous = this.current;
    this.current = store;
    try {
      return callback();
    } finally {
      this.current = previous;
    }
  }
}

export function getGlobalAsyncLocalStorage(): AsyncLocalStorageConstructor | undefined {
  const candidate = (globalThis as { AsyncLocalStorage?: AsyncLocalStorageConstructor })
    .AsyncLocalStorage;
  return typeof candidate === 'function' ? candidate : undefined;
}

/** Returns an isolated snapshot suitable for queues, callbacks, and detached tasks. */
export function cloneLogContext(context: LogContext): LogContext {
  return {
    ...context,
    ...(context.loggedInUser === undefined
      ? {}
      : { loggedInUser: { ...context.loggedInUser } }),
    ...(context.users === undefined
      ? {}
      : { users: context.users.map((user) => ({ ...user })) }),
    ...(context.fields === undefined ? {} : { fields: { ...context.fields } }),
    ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    ...(context.traceIds === undefined ? {} : { traceIds: [...context.traceIds] }),
    ...(context.routineId === undefined ? {} : { routineId: context.routineId }),
    ...(context.tags === undefined ? {} : { tags: [...context.tags] }),
  };
}

export function mergeLogContext(current: LogContext, patch: LogContext): void {
  if (patch.loggedInUser) {
    current.loggedInUser = { ...current.loggedInUser, ...patch.loggedInUser };
  }
  if (patch.users && patch.users.length > 0) {
    current.users = [...(current.users ?? []), ...patch.users.map((user) => ({ ...user }))];
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function contextField(context: LogContext | undefined, key: string): string | undefined {
  return nonEmptyString(context?.fields?.[key]);
}

export interface LogContextApi {
  logContextStorage: LogContextStorage;
  isAsyncContextTracked(): boolean;
  runWithLogContext<T>(context: LogContext, callback: () => T): T;
  runWithMergedLogContext<T>(patch: LogContext, callback: () => T): T;
  getLogContext(): LogContext | undefined;
  currentLogRequestId(): string | undefined;
  currentLogTraceId(): string | undefined;
  currentLogUserId(): string | undefined;
  currentLogLoggedInUserId(): string | undefined;
  currentLogTenantId(): string | undefined;
  /** Copies the current frame so it can be re-entered in detached work. */
  captureLogContext(): LogContext | undefined;
  runWithCapturedLogContext<T>(snapshot: LogContext | undefined, callback: () => T): T;
  updateLogContext(patch: LogContext): boolean;
  setContextLoggedInUser(user: LogUser): boolean;
  logContextProvider: LogContextProvider;
  installLogContextProvider(): () => void;
}

export function createLogContextApi(
  logContextStorage: LogContextStorage,
  asyncTracked: boolean,
): LogContextApi {
  const logContextProvider: LogContextProvider = () => logContextStorage.getStore();
  const currentLogUserId = (): string | undefined => {
    const context = logContextStorage.getStore();
    return (
      nonEmptyString(context?.loggedInUser?.id) ??
      contextField(context, 'user.id') ??
      nonEmptyString(context?.loggedInUser?.ddUserId)
    );
  };

  return {
    logContextStorage,
    isAsyncContextTracked: () => asyncTracked,
    runWithLogContext: (context, callback) =>
      logContextStorage.run(cloneLogContext(context), callback),
    runWithMergedLogContext: (patch, callback) => {
      const current = logContextStorage.getStore();
      const next = current === undefined ? cloneLogContext(patch) : cloneLogContext(current);
      if (current !== undefined) {
        mergeLogContext(next, patch);
      }
      return logContextStorage.run(next, callback);
    },
    getLogContext: () => logContextStorage.getStore(),
    currentLogRequestId: () =>
      contextField(logContextStorage.getStore(), 'request.id'),
    currentLogTraceId: () => {
      const context = logContextStorage.getStore();
      return nonEmptyString(context?.traceId) ?? contextField(context, 'trace.id');
    },
    currentLogUserId,
    currentLogLoggedInUserId: currentLogUserId,
    currentLogTenantId: () =>
      contextField(logContextStorage.getStore(), 'tenant.id'),
    captureLogContext: () => {
      const current = logContextStorage.getStore();
      return current === undefined ? undefined : cloneLogContext(current);
    },
    runWithCapturedLogContext: (snapshot, callback) =>
      snapshot === undefined
        ? callback()
        : logContextStorage.run(cloneLogContext(snapshot), callback),
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
