import type {
  LogArgument,
  LogContext,
  LogEvent,
  LogFields,
  LogUser,
} from './base-logger.js';
import type { LogContextApi } from './context-shared.js';

/**
 * Full server execution context shared by TypeScript and the native SDKs.
 *
 * The base logger already understands user, trace, routine, tag, and field
 * values. Span state and baggage are projected into OpenTelemetry-compatible
 * fields so ordinary logger calls receive them through the installed provider;
 * `enrichEvent()` additionally appends top-level context/meta payloads.
 */
export interface ExecutionLogContext extends LogContext {
  spanId?: string;
  traceFlags?: number;
  traceState?: string;
  baggage?: Record<string, string>;
  context?: LogArgument[];
  meta?: LogArgument[];
}

export interface ExecutionContextApi {
  runWithExecutionLogContext<T>(context: ExecutionLogContext, callback: () => T): T;
  getExecutionLogContext(): ExecutionLogContext | undefined;
  updateExecutionLogContext(patch: ExecutionLogContext): boolean;
  setExecutionLoggedInUser(user: LogUser): boolean;
  executionLogContextProvider(): LogContext | undefined;
  installExecutionLogContextProvider(): () => void;
  enrichEvent<TEvent extends LogEvent>(event: TEvent, context?: ExecutionLogContext): TEvent;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function appendUnique(values: string[], candidate: string | undefined): void {
  const normalized = String(candidate ?? '').trim();
  if (normalized && !values.includes(normalized)) {
    values.push(normalized);
  }
}

export function snapshotExecutionLogContext(
  context: ExecutionLogContext,
): ExecutionLogContext {
  return {
    ...context,
    ...(context.loggedInUser ? { loggedInUser: { ...context.loggedInUser } } : {}),
    ...(context.users ? { users: context.users.map((user) => ({ ...user })) } : {}),
    ...(context.fields ? { fields: { ...context.fields } } : {}),
    ...(context.traceIds ? { traceIds: [...context.traceIds] } : {}),
    ...(context.baggage ? { baggage: { ...context.baggage } } : {}),
    ...(context.tags ? { tags: [...context.tags] } : {}),
    ...(context.context ? { context: [...context.context] } : {}),
    ...(context.meta ? { meta: [...context.meta] } : {}),
  };
}

/** Immutable nested-scope merge matching the Go/Rust/Dart/Gleam adapters. */
export function mergeExecutionLogContexts(
  base: ExecutionLogContext = {},
  patch: ExecutionLogContext = {},
): ExecutionLogContext {
  const current = snapshotExecutionLogContext(base);
  const traces: string[] = [];
  appendUnique(traces, current.traceId);
  for (const traceId of current.traceIds ?? []) appendUnique(traces, traceId);
  appendUnique(traces, patch.traceId);
  for (const traceId of patch.traceIds ?? []) appendUnique(traces, traceId);

  const tags: string[] = [];
  for (const tag of current.tags ?? []) appendUnique(tags, tag);
  for (const tag of patch.tags ?? []) appendUnique(tags, tag);

  const traceId = patch.traceId ?? current.traceId ?? traces[0];
  const spanId = hasOwn(patch, 'spanId') ? patch.spanId : current.spanId;
  const traceFlags = hasOwn(patch, 'traceFlags')
    ? patch.traceFlags
    : current.traceFlags;
  const traceState = hasOwn(patch, 'traceState')
    ? patch.traceState
    : current.traceState;
  const routineId = patch.routineId ?? current.routineId;

  return snapshotExecutionLogContext({
    ...current,
    ...patch,
    loggedInUser: {
      ...(current.loggedInUser ?? {}),
      ...(patch.loggedInUser ?? {}),
    },
    users: [...(current.users ?? []), ...(patch.users ?? [])],
    fields: { ...(current.fields ?? {}), ...(patch.fields ?? {}) },
    ...(traceId === undefined ? {} : { traceId }),
    traceIds: traces,
    ...(spanId === undefined ? {} : { spanId }),
    ...(traceFlags === undefined ? {} : { traceFlags }),
    ...(traceState === undefined ? {} : { traceState }),
    baggage: { ...(current.baggage ?? {}), ...(patch.baggage ?? {}) },
    ...(routineId === undefined ? {} : { routineId }),
    tags,
    context: [...(current.context ?? []), ...(patch.context ?? [])],
    meta: [...(current.meta ?? []), ...(patch.meta ?? [])],
  });
}

/** Project the full context into the wire fields understood by BaseLogger. */
export function toLoggerLogContext(context: ExecutionLogContext): LogContext {
  const snapshot = snapshotExecutionLogContext(context);
  const fields: LogFields = { ...(snapshot.fields ?? {}) };
  if (snapshot.spanId !== undefined) fields['otel.span_id'] = snapshot.spanId;
  if (snapshot.traceFlags !== undefined) fields['otel.trace_flags'] = snapshot.traceFlags;
  if (snapshot.traceState !== undefined) fields['otel.trace_state'] = snapshot.traceState;
  if (snapshot.baggage && Object.keys(snapshot.baggage).length > 0) {
    fields['otel.baggage'] = { ...snapshot.baggage };
  }
  // Direct logger calls still retain rich payloads even before an event helper
  // is used. `enrichEvent()` also emits these through the top-level wire fields.
  if (snapshot.context && snapshot.context.length > 0) {
    fields['next_logger.context'] = [...snapshot.context];
  }
  if (snapshot.meta && snapshot.meta.length > 0) {
    fields['next_logger.meta'] = [...snapshot.meta];
  }
  return {
    ...(snapshot.loggedInUser ? { loggedInUser: snapshot.loggedInUser } : {}),
    ...(snapshot.users ? { users: snapshot.users } : {}),
    fields,
    ...(snapshot.traceId ? { traceId: snapshot.traceId } : {}),
    ...(snapshot.traceIds ? { traceIds: snapshot.traceIds } : {}),
    ...(snapshot.routineId ? { routineId: snapshot.routineId } : {}),
    ...(snapshot.tags ? { tags: snapshot.tags } : {}),
  };
}

function toStoredContext(context: ExecutionLogContext): ExecutionLogContext {
  const snapshot = snapshotExecutionLogContext(context);
  return { ...snapshot, ...toLoggerLogContext(snapshot) };
}

export function createExecutionContextApi(contextApi: LogContextApi): ExecutionContextApi {
  const getRaw = (): ExecutionLogContext | undefined =>
    contextApi.getLogContext() as ExecutionLogContext | undefined;

  const getExecutionLogContext = (): ExecutionLogContext | undefined => {
    const current = getRaw();
    return current ? snapshotExecutionLogContext(current) : undefined;
  };

  const executionLogContextProvider = (): LogContext | undefined => {
    const current = getExecutionLogContext();
    return current ? toLoggerLogContext(current) : undefined;
  };

  return {
    runWithExecutionLogContext: (patch, callback) => {
      const merged = mergeExecutionLogContexts(getRaw() ?? {}, patch);
      return contextApi.runWithLogContext(toStoredContext(merged), callback);
    },
    getExecutionLogContext,
    updateExecutionLogContext: (patch) => {
      const current = getRaw();
      if (!current) return false;
      const merged = toStoredContext(mergeExecutionLogContexts(current, patch));
      for (const key of Object.keys(current)) {
        delete (current as Record<string, unknown>)[key];
      }
      Object.assign(current, merged);
      return true;
    },
    setExecutionLoggedInUser: (user) => {
      const current = getRaw();
      if (!current) return false;
      const merged = toStoredContext(
        mergeExecutionLogContexts(current, { loggedInUser: { ...user } }),
      );
      Object.assign(current, merged);
      return true;
    },
    executionLogContextProvider,
    installExecutionLogContextProvider: () => {
      // The base provider reads the same frame; every frame created here is
      // projected into BaseLogger-compatible OpenTelemetry fields.
      return contextApi.installLogContextProvider();
    },
    enrichEvent: (event, explicitContext) => {
      const context = explicitContext ?? getExecutionLogContext();
      if (!context) return event;
      const projected = toLoggerLogContext(context);
      if (projected.fields) event.addFields(projected.fields);
      if (context.loggedInUser) event.addLoggedInUserInfo(context.loggedInUser);
      for (const user of context.users ?? []) event.addUserInfo(user);
      if (context.traceId) event.addTrace(context.traceId, { makeFirst: true });
      for (const traceId of context.traceIds ?? []) event.addTrace(traceId);
      if (context.routineId) event.addRoutineId(context.routineId);
      if (context.tags) event.addTags(...context.tags);
      for (const value of context.context ?? []) event.addContext(value);
      for (const value of context.meta ?? []) event.addMeta(value);
      return event;
    },
  };
}
