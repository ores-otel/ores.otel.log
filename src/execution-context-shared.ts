import type {
  LogArgument,
  LogContext,
  LogEvent,
  LogFields,
  LogUser,
} from './base-logger.js';
import type { LogContextApi } from './context-shared.js';

/** Versioned semantic contract shared by middleware and telemetry SDKs. */
export const REQUEST_CONTEXT_SCHEMA = 'ores.request-context.v1' as const;

/**
 * Small, allowlisted request identity. Values are correlation identifiers, not
 * authorization credentials; never place tokens, cookies, or raw claims here.
 */
export interface RequestIdentityContext {
  requestId?: string;
  loggedInUserId?: string;
  tenantId?: string;
  sessionId?: string;
  correlationId?: string;
  parentRequestId?: string;
  operation?: string;
  serviceName?: string;
  startedAtUnixMs?: number;
  deadlineUnixMs?: number;
  locale?: string;
}

/**
 * Full server execution context shared by TypeScript and the native SDKs.
 *
 * The base logger already understands user, trace, routine, tag, and field
 * values. Request identity, span state, and baggage are projected into stable
 * structured fields so ordinary logger calls receive them through the installed
 * provider; `enrichEvent()` additionally appends top-level context/meta payloads.
 */
export interface ExecutionLogContext extends LogContext, RequestIdentityContext {
  spanId?: string;
  traceFlags?: number;
  traceState?: string;
  baggage?: Record<string, string>;
  context?: LogArgument[];
  meta?: LogArgument[];
}

export interface ExecutionContextApi {
  /**
   * Runs a callback in a new immutable child snapshot. Nested calls inherit
   * omitted parent fields and override only the supplied values.
   */
  runWithExecutionLogContext<T>(context: ExecutionLogContext, callback: () => T): T;
  /** Adds authenticated-user metadata through the same immutable child scope. */
  runWithExecutionLoggedInUser<T>(user: LogUser, callback: () => T): T;
  getExecutionLogContext(): ExecutionLogContext | undefined;
  captureExecutionLogContext(): ExecutionLogContext | undefined;
  runWithCapturedExecutionLogContext<T>(
    snapshot: ExecutionLogContext | undefined,
    callback: () => T,
  ): T;
  getRequestId(): string | undefined;
  getLoggedInUserId(): string | undefined;
  getTenantId(): string | undefined;
  getSessionId(): string | undefined;
  getCorrelationId(): string | undefined;
  executionLogContextProvider(): LogContext | undefined;
  installExecutionLogContextProvider(): () => void;
  enrichEvent<TEvent extends LogEvent>(event: TEvent, context?: ExecutionLogContext): TEvent;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** Stable authenticated-user ID without exposing email or provider tokens. */
export function loggedInUserIdFromContext(
  context: ExecutionLogContext | undefined,
): string | undefined {
  if (!context) return undefined;
  return (
    normalizedString(context.loggedInUserId) ??
    normalizedString(context.loggedInUser?.id) ??
    normalizedString(context.loggedInUser?.ddUserId)
  );
}

function appendUnique(values: string[], candidate: string | undefined): void {
  const normalized = normalizedString(candidate);
  if (normalized && !values.includes(normalized)) {
    values.push(normalized);
  }
}

function scalarFromPatch<T extends keyof RequestIdentityContext>(
  current: RequestIdentityContext,
  patch: RequestIdentityContext,
  key: T,
): RequestIdentityContext[T] {
  return hasOwn(patch, key) ? patch[key] : current[key];
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

  const requestId = scalarFromPatch(current, patch, 'requestId');
  const tenantId = scalarFromPatch(current, patch, 'tenantId');
  const sessionId = scalarFromPatch(current, patch, 'sessionId');
  const correlationId = scalarFromPatch(current, patch, 'correlationId');
  const parentRequestId = scalarFromPatch(current, patch, 'parentRequestId');
  const operation = scalarFromPatch(current, patch, 'operation');
  const serviceName = scalarFromPatch(current, patch, 'serviceName');
  const startedAtUnixMs = scalarFromPatch(current, patch, 'startedAtUnixMs');
  const deadlineUnixMs = scalarFromPatch(current, patch, 'deadlineUnixMs');
  const locale = scalarFromPatch(current, patch, 'locale');
  const traceId = patch.traceId ?? current.traceId ?? traces[0];
  const spanId = hasOwn(patch, 'spanId') ? patch.spanId : current.spanId;
  const traceFlags = hasOwn(patch, 'traceFlags')
    ? patch.traceFlags
    : current.traceFlags;
  const traceState = hasOwn(patch, 'traceState')
    ? patch.traceState
    : current.traceState;
  const routineId = patch.routineId ?? current.routineId;

  const loggedInUser = {
    ...(current.loggedInUser ?? {}),
    ...(patch.loggedInUser ?? {}),
  };
  const loggedInUserId =
    normalizedString(patch.loggedInUserId) ??
    normalizedString(patch.loggedInUser?.id) ??
    normalizedString(patch.loggedInUser?.ddUserId) ??
    loggedInUserIdFromContext(current);
  if (loggedInUserId) loggedInUser.id = loggedInUserId;

  return snapshotExecutionLogContext({
    ...current,
    ...patch,
    ...(requestId === undefined ? {} : { requestId }),
    ...(loggedInUserId === undefined ? {} : { loggedInUserId }),
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(parentRequestId === undefined ? {} : { parentRequestId }),
    ...(operation === undefined ? {} : { operation }),
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(startedAtUnixMs === undefined ? {} : { startedAtUnixMs }),
    ...(deadlineUnixMs === undefined ? {} : { deadlineUnixMs }),
    ...(locale === undefined ? {} : { locale }),
    loggedInUser,
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

function putStringField(
  fields: LogFields,
  key: string,
  value: string | undefined,
): void {
  const normalized = normalizedString(value);
  if (normalized) fields[key] = normalized;
}

function putNumberField(
  fields: LogFields,
  key: string,
  value: number | undefined,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) fields[key] = value;
}

/** Project the full context into the wire fields understood by BaseLogger. */
export function toLoggerLogContext(context: ExecutionLogContext): LogContext {
  const snapshot = snapshotExecutionLogContext(context);
  const fields: LogFields = { ...(snapshot.fields ?? {}) };
  putStringField(fields, 'request.id', snapshot.requestId);
  putStringField(fields, 'user.id', loggedInUserIdFromContext(snapshot));
  putStringField(fields, 'tenant.id', snapshot.tenantId);
  putStringField(fields, 'session.id', snapshot.sessionId);
  putStringField(fields, 'correlation.id', snapshot.correlationId);
  putStringField(fields, 'request.parent_id', snapshot.parentRequestId);
  putStringField(fields, 'operation.name', snapshot.operation);
  putStringField(fields, 'service.name', snapshot.serviceName);
  putStringField(fields, 'request.locale', snapshot.locale);
  putNumberField(fields, 'request.started_at_unix_ms', snapshot.startedAtUnixMs);
  putNumberField(fields, 'request.deadline_unix_ms', snapshot.deadlineUnixMs);
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

  const loggedInUser = { ...(snapshot.loggedInUser ?? {}) };
  const loggedInUserId = loggedInUserIdFromContext(snapshot);
  if (loggedInUserId) loggedInUser.id = loggedInUserId;

  return {
    ...(Object.keys(loggedInUser).length > 0 ? { loggedInUser } : {}),
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

  const runWithExecutionLogContext = <T>(
    patch: ExecutionLogContext,
    callback: () => T,
  ): T => {
    const merged = mergeExecutionLogContexts(getRaw() ?? {}, patch);
    return contextApi.runWithLogContext(toStoredContext(merged), callback);
  };

  return {
    runWithExecutionLogContext,
    runWithExecutionLoggedInUser: (user, callback) =>
      runWithExecutionLogContext(
        {
          loggedInUser: { ...user },
          ...(normalizedString(user.id) ? { loggedInUserId: String(user.id) } : {}),
        },
        callback,
      ),
    getExecutionLogContext,
    captureExecutionLogContext: getExecutionLogContext,
    runWithCapturedExecutionLogContext: (snapshot, callback) =>
      contextApi.runWithCapturedLogContext(
        snapshot === undefined ? undefined : toStoredContext(snapshot),
        callback,
      ),
    getRequestId: () => normalizedString(getRaw()?.requestId),
    getLoggedInUserId: () => loggedInUserIdFromContext(getRaw()),
    getTenantId: () => normalizedString(getRaw()?.tenantId),
    getSessionId: () => normalizedString(getRaw()?.sessionId),
    getCorrelationId: () => normalizedString(getRaw()?.correlationId),
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
      const loggedInUser = projected.loggedInUser;
      if (loggedInUser) event.addLoggedInUserInfo(loggedInUser);
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
