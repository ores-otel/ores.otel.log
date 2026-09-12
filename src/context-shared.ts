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
  /** Temporarily clears the active frame when the runtime supports it. */
  exit?<R>(callback: () => R): R;
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

  exit<R>(callback: () => R): R {
    const previous = this.current;
    this.current = undefined;
    try {
      return callback();
    } finally {
      this.current = previous;
    }
  }
}

/**
 * Fail-closed storage for concurrent server isolates without a native async
 * context primitive. Explicit context parameters still work; ambient getters
 * deliberately return `undefined` rather than risk cross-request data bleed.
 */
export class ExplicitOnlyLogContextStorage implements LogContextStorage {
  getStore(): LogContext | undefined {
    return undefined;
  }

  run<R>(_store: LogContext, callback: () => R): R {
    return callback();
  }

  exit<R>(callback: () => R): R {
    return callback();
  }
}

export function getGlobalAsyncLocalStorage(): AsyncLocalStorageConstructor | undefined {
  const candidate = (globalThis as {
    AsyncLocalStorage?: AsyncLocalStorageConstructor;
  }).AsyncLocalStorage;
  return typeof candidate === 'function' ? candidate : undefined;
}

/**
 * Recursive snapshots are bounded so an untrusted context cannot consume
 * unbounded stack or heap before the request reaches application code.
 */
const MAX_CONTEXT_CLONE_DEPTH = 128;
const MAX_CONTEXT_CLONE_NODES = 10_000;

// HOT-PATH (imperative by design): the recursive context snapshot runs on every
// context read and write (per request, per log call with ambient context). The
// visit state is shared by every level of the recursion so cycles and shared
// references resolve to the same copy; threading an immutable state through
// each return would rebuild the seen-map or the counter per node. The state is
// created inside `cloneContextValue` and never escapes it; callers receive a
// detached value graph.
interface ContextCloneState {
  readonly seen: WeakMap<object, object>;
  nodes: number;
}

function hasOwnAccessorProperties(source: object): boolean {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor && !('value' in descriptor)) {
      return true;
    }
  }
  return false;
}

function cloneOwnDataProperties(
  source: object,
  target: object,
  state: ContextCloneState,
  depth: number,
  skip: ReadonlySet<PropertyKey> = new Set<PropertyKey>(),
): void {
  for (const key of Reflect.ownKeys(source)) {
    if (skip.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !('value' in descriptor)) continue;
    Object.defineProperty(target, key, {
      ...descriptor,
      value: cloneContextValueInternal(descriptor.value, state, depth + 1),
    });
  }
}

function cloneArrayBufferLike(value: ArrayBufferLike): ArrayBufferLike {
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }
  if (
    typeof SharedArrayBuffer !== 'undefined' &&
    value instanceof SharedArrayBuffer
  ) {
    const copy = new SharedArrayBuffer(value.byteLength);
    new Uint8Array(copy).set(new Uint8Array(value));
    return copy;
  }
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(new Uint8Array(value));
  return copy;
}

function cloneArrayBufferView(value: ArrayBufferView, buffer: ArrayBufferLike): ArrayBufferView {
  if (value instanceof DataView) {
    return new DataView(buffer, value.byteOffset, value.byteLength);
  }
  const source = value as Exclude<ArrayBufferView, DataView> & {
    readonly length: number;
  };
  const Constructor = source.constructor as new (
    buffer: ArrayBufferLike,
    byteOffset?: number,
    length?: number,
  ) => ArrayBufferView;
  return new Constructor(buffer, source.byteOffset, source.length);
}

function cloneContextValueInternal(
  value: unknown,
  state: ContextCloneState,
  depth: number,
): unknown {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return value;
  }
  // Functions and other executable handles are runtime-local opaque values.
  if (typeof value === 'function') return value;
  if (depth > MAX_CONTEXT_CLONE_DEPTH) {
    throw new RangeError(
      `context snapshot exceeds maximum depth ${MAX_CONTEXT_CLONE_DEPTH}`,
    );
  }

  const object = value as object;
  const known = state.seen.get(object);
  if (known !== undefined) return known;
  state.nodes += 1;
  if (state.nodes > MAX_CONTEXT_CLONE_NODES) {
    throw new RangeError(
      `context snapshot exceeds maximum node count ${MAX_CONTEXT_CLONE_NODES}`,
    );
  }

  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    state.seen.set(object, copy);
    return copy;
  }
  if (value instanceof RegExp) {
    const copy = new RegExp(value.source, value.flags);
    copy.lastIndex = value.lastIndex;
    state.seen.set(object, copy);
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    state.seen.set(object, copy);
    for (const [key, entry] of value) {
      copy.set(
        cloneContextValueInternal(key, state, depth + 1),
        cloneContextValueInternal(entry, state, depth + 1),
      );
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    state.seen.set(object, copy);
    for (const entry of value) {
      copy.add(cloneContextValueInternal(entry, state, depth + 1));
    }
    return copy;
  }
  if (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' &&
      value instanceof SharedArrayBuffer)
  ) {
    const copy = cloneArrayBufferLike(value);
    state.seen.set(object, copy as object);
    return copy;
  }
  if (ArrayBuffer.isView(value)) {
    const clonedBuffer = cloneContextValueInternal(
      value.buffer,
      state,
      depth + 1,
    ) as ArrayBufferLike;
    const copy = cloneArrayBufferView(value, clonedBuffer);
    state.seen.set(object, copy as object);
    return copy;
  }
  if (value instanceof Error) {
    const copy = Object.create(Object.getPrototypeOf(value)) as Error;
    state.seen.set(object, copy);
    // Error.stack may be an accessor on some engines. Copy data properties
    // only; invoking diagnostics accessors during context admission is unsafe.
    cloneOwnDataProperties(value, copy, state, depth);
    return copy;
  }
  if (Array.isArray(value)) {
    // An accessor-bearing record is an opaque runtime handle. Keeping it by
    // reference is safer than invoking a getter or manufacturing half a clone.
    if (hasOwnAccessorProperties(value)) return value;
    const copy: unknown[] = new Array(value.length);
    state.seen.set(object, copy);
    cloneOwnDataProperties(
      value,
      copy,
      state,
      depth,
      new Set<PropertyKey>(['length']),
    );
    return copy;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (hasOwnAccessorProperties(value)) return value;
  const copy = Object.create(prototype) as object;
  state.seen.set(object, copy);
  cloneOwnDataProperties(value, copy, state, depth);
  return copy;
}

/**
 * Recursively detaches supported structured values while preserving cycles and
 * shared references within the returned graph. Runtime-local opaque values are
 * retained by identity and are never serialized implicitly.
 */
export function cloneContextValue<T>(value: T): T {
  return cloneContextValueInternal(
    value,
    { seen: new WeakMap<object, object>(), nodes: 0 },
    0,
  ) as T;
}

/** Returns an isolated snapshot suitable for queues, callbacks, and detached tasks. */
export function cloneLogContext(context: LogContext): LogContext {
  return cloneContextValue(context);
}

/**
 * The keys a caller-owned patch changes when merged over `current`, as a new
 * partial frame: objects merge, lists append, trace ids and tags de-duplicate
 * in first-seen order, and present scalars replace their parent value. Neither
 * argument is written to; the patch is recursively snapshotted before any of
 * its values become observable.
 */
function logContextChanges(current: LogContext, patch: LogContext): Partial<LogContext> {
  const ownedPatch = cloneLogContext(patch);
  const existingTraces = current.traceIds ?? (current.traceId ? [current.traceId] : []);
  // The primary trace id is folded in first, then the patch list, so order and
  // de-duplication match successive updates.
  const withPrimary = ownedPatch.traceId
    ? Array.from(new Set([...existingTraces, ownedPatch.traceId]))
    : undefined;
  const traceIds =
    ownedPatch.traceIds && ownedPatch.traceIds.length > 0
      ? Array.from(
          new Set([...(withPrimary ?? current.traceIds ?? existingTraces), ...ownedPatch.traceIds]),
        )
      : withPrimary;
  return {
    ...(ownedPatch.loggedInUser
      ? { loggedInUser: { ...(current.loggedInUser ?? {}), ...ownedPatch.loggedInUser } }
      : {}),
    ...(ownedPatch.users && ownedPatch.users.length > 0
      ? { users: [...(current.users ?? []), ...ownedPatch.users] }
      : {}),
    ...(ownedPatch.fields ? { fields: { ...(current.fields ?? {}), ...ownedPatch.fields } } : {}),
    ...(ownedPatch.traceId ? { traceId: ownedPatch.traceId } : {}),
    ...(traceIds ? { traceIds } : {}),
    ...(ownedPatch.routineId ? { routineId: ownedPatch.routineId } : {}),
    ...(ownedPatch.tags && ownedPatch.tags.length > 0
      ? { tags: Array.from(new Set([...(current.tags ?? []), ...ownedPatch.tags])) }
      : {}),
  };
}

/** The frame that results from merging `patch` over `current`, as a new object. */
export function mergedLogContext(current: LogContext, patch: LogContext): LogContext {
  return { ...current, ...logContextChanges(current, patch) };
}

/**
 * Merge a caller-owned patch into the already-owned *active* frame. This is the
 * one in-place write in this module: an AsyncLocalStorage frame cannot be
 * swapped for a new object without re-entering `run`, so `updateLogContext`
 * must edit the frame the store already holds. The changed keys are computed
 * as a value first; only their assignment is an effect.
 */
export function mergeLogContext(current: LogContext, patch: LogContext): void {
  Object.assign(current, logContextChanges(current, patch));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function contextField(
  context: LogContext | undefined,
  key: string,
): string | undefined {
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
  runWithCapturedLogContext<T>(
    snapshot: LogContext | undefined,
    callback: () => T,
  ): T;
  updateLogContext(patch: LogContext): boolean;
  setContextLoggedInUser(user: LogUser): boolean;
  logContextProvider: LogContextProvider;
  installLogContextProvider(): () => void;
}

export function createLogContextApi(
  logContextStorage: LogContextStorage,
  asyncTracked: boolean,
): LogContextApi {
  // The provider is public and therefore obeys the same defensive-read
  // boundary as getLogContext. Scalar helpers below still read the owned frame
  // directly and remain O(1).
  const logContextProvider: LogContextProvider = () => {
    const current = logContextStorage.getStore();
    return current === undefined ? undefined : cloneLogContext(current);
  };
  const currentLogUserId = (): string | undefined => {
    const context = logContextStorage.getStore();
    return (
      nonEmptyString(context?.loggedInUser?.id) ??
      contextField(context, 'user.id') ??
      nonEmptyString(context?.loggedInUser?.ddUserId)
    );
  };
  const runWithoutLogContext = <T>(callback: () => T): T => {
    if (typeof logContextStorage.exit === 'function') {
      return logContextStorage.exit(callback);
    }
    // A compatible runtime may expose run/getStore without exit. An empty
    // child frame still prevents the caller's request identity from leaking
    // into a callback whose captured snapshot was explicitly absent.
    return logContextStorage.run({}, callback);
  };

  return {
    logContextStorage,
    isAsyncContextTracked: () => asyncTracked,
    runWithLogContext: (context, callback) =>
      logContextStorage.run(cloneLogContext(context), callback),
    runWithMergedLogContext: (patch, callback) => {
      const current = logContextStorage.getStore();
      const next =
        current === undefined
          ? cloneLogContext(patch)
          : mergedLogContext(cloneLogContext(current), patch);
      return logContextStorage.run(next, callback);
    },
    getLogContext: () => {
      const current = logContextStorage.getStore();
      return current === undefined ? undefined : cloneLogContext(current);
    },
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
        ? runWithoutLogContext(callback)
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
