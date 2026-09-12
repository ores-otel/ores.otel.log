import type { LogContext } from './base-logger.js';
import { cloneLogContext, type LogContextApi } from './context-shared.js';

export const requestFailureKinds = Object.freeze([
  'exception',
  'panic',
  'timeout',
  'cancelled',
  'disconnect',
] as const);

export type RequestFailureKind = (typeof requestFailureKinds)[number];

export type RequestBoundary =
  | Readonly<{
      transport: 'http';
      scope: 'request';
      phase: string;
      operation?: string;
    }>
  | Readonly<{
      transport: 'tcp';
      scope: 'connection' | 'message';
      phase: string;
      operation?: string;
      connectionId?: string;
      messageId?: string;
    }>
  | Readonly<{
      transport: 'websocket';
      scope: 'session' | 'message';
      phase: string;
      operation?: string;
      connectionId?: string;
      messageId?: string;
    }>;

export interface RequestBoundaryFailure {
  readonly kind: RequestFailureKind;
  readonly boundary: RequestBoundary;
  readonly context: Readonly<LogContext>;
  readonly cause: unknown;
  readonly observedAtUnixMs: number;
}

export type RequestBoundaryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: RequestBoundaryFailure }>;

export interface RequestBoundaryOptions {
  /** Classifies a caught value without changing the original failure cause. */
  classify?: (
    cause: unknown,
    boundary: RequestBoundary,
  ) => RequestFailureKind;
  /**
   * Runs before the context scope unwinds. Reporter failures are intentionally
   * ignored so telemetry cannot replace the request's original outcome.
   */
  report?: (
    failure: RequestBoundaryFailure,
  ) => void | Promise<void>;
  /** Injectable clock for deterministic conformance tests. */
  now?: () => number;
}

export interface RequestBoundaryApi {
  runWithRequestBoundary<T>(
    context: LogContext,
    boundary: RequestBoundary,
    operation: () => T | Promise<T>,
    options?: RequestBoundaryOptions,
  ): Promise<RequestBoundaryResult<T>>;
}

const validFailureKinds = new Set<RequestFailureKind>(requestFailureKinds);

function exhaustive(value: never): never {
  throw new TypeError(`unsupported request boundary: ${String(value)}`);
}

function boundedText(
  value: string,
  field: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new TypeError(`${field} must be a non-empty bounded text value`);
  }
  return normalized;
}

function optionalText(
  value: string | undefined,
  field: string,
): string | undefined {
  return value === undefined ? undefined : boundedText(value, field, 256);
}

function normalizeBoundary(boundary: RequestBoundary): RequestBoundary {
  const phase = boundedText(boundary.phase, 'phase', 128);
  const operation = optionalText(boundary.operation, 'operation');

  switch (boundary.transport) {
    case 'http':
      return Object.freeze({
        transport: 'http',
        scope: 'request',
        phase,
        ...(operation === undefined ? {} : { operation }),
      });
    case 'tcp': {
      const connectionId = optionalText(boundary.connectionId, 'connectionId');
      const messageId = optionalText(boundary.messageId, 'messageId');
      return Object.freeze({
        transport: 'tcp',
        scope: boundary.scope,
        phase,
        ...(operation === undefined ? {} : { operation }),
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(messageId === undefined ? {} : { messageId }),
      });
    }
    case 'websocket': {
      const connectionId = optionalText(boundary.connectionId, 'connectionId');
      const messageId = optionalText(boundary.messageId, 'messageId');
      return Object.freeze({
        transport: 'websocket',
        scope: boundary.scope,
        phase,
        ...(operation === undefined ? {} : { operation }),
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(messageId === undefined ? {} : { messageId }),
      });
    }
    default:
      return exhaustive(boundary);
  }
}

function freezeContext(context: LogContext): Readonly<LogContext> {
  const snapshot = cloneLogContext(context);
  if (snapshot.loggedInUser !== undefined) Object.freeze(snapshot.loggedInUser);
  if (snapshot.users !== undefined) {
    for (const user of snapshot.users) Object.freeze(user);
    Object.freeze(snapshot.users);
  }
  if (snapshot.fields !== undefined) Object.freeze(snapshot.fields);
  if (snapshot.traceIds !== undefined) Object.freeze(snapshot.traceIds);
  if (snapshot.tags !== undefined) Object.freeze(snapshot.tags);
  return Object.freeze(snapshot);
}

function classifyFailure(
  cause: unknown,
  boundary: RequestBoundary,
  classify: RequestBoundaryOptions['classify'],
): RequestFailureKind {
  if (classify === undefined) return 'exception';
  try {
    const candidate = classify(cause, boundary);
    return validFailureKinds.has(candidate) ? candidate : 'exception';
  } catch {
    return 'exception';
  }
}

export function httpRequestBoundary(
  phase: string,
  operation?: string,
): RequestBoundary {
  return normalizeBoundary({
    transport: 'http',
    scope: 'request',
    phase,
    ...(operation === undefined ? {} : { operation }),
  });
}

export function tcpConnectionBoundary(
  phase: string,
  connectionId?: string,
  operation?: string,
): RequestBoundary {
  return normalizeBoundary({
    transport: 'tcp',
    scope: 'connection',
    phase,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(operation === undefined ? {} : { operation }),
  });
}

export function tcpMessageBoundary(
  phase: string,
  connectionId?: string,
  messageId?: string,
  operation?: string,
): RequestBoundary {
  return normalizeBoundary({
    transport: 'tcp',
    scope: 'message',
    phase,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(operation === undefined ? {} : { operation }),
  });
}

export function webSocketSessionBoundary(
  phase: string,
  connectionId?: string,
  operation?: string,
): RequestBoundary {
  return normalizeBoundary({
    transport: 'websocket',
    scope: 'session',
    phase,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(operation === undefined ? {} : { operation }),
  });
}

export function webSocketMessageBoundary(
  phase: string,
  connectionId?: string,
  messageId?: string,
  operation?: string,
): RequestBoundary {
  return normalizeBoundary({
    transport: 'websocket',
    scope: 'message',
    phase,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(operation === undefined ? {} : { operation }),
  });
}

/**
 * Builds one failure boundary over the runtime's canonical context carrier.
 * This helper catches only failures from the supplied logical operation. It
 * deliberately does not install process-global uncaught-exception handlers.
 */
export function createRequestBoundaryApi(
  contextApi: Pick<
    LogContextApi,
    'runWithLogContext' | 'captureLogContext'
  >,
): RequestBoundaryApi {
  return {
    async runWithRequestBoundary<T>(
      context: LogContext,
      boundary: RequestBoundary,
      operation: () => T | Promise<T>,
      options: RequestBoundaryOptions = {},
    ): Promise<RequestBoundaryResult<T>> {
      const explicitContext = freezeContext(context);
      const normalizedBoundary = normalizeBoundary(boundary);
      const now = options.now ?? Date.now;

      return contextApi.runWithLogContext(context, async () => {
        try {
          return Object.freeze({
            ok: true as const,
            value: await operation(),
          });
        } catch (cause) {
          const activeContext = contextApi.captureLogContext();
          const failure = Object.freeze({
            kind: classifyFailure(cause, normalizedBoundary, options.classify),
            boundary: normalizedBoundary,
            context:
              activeContext === undefined
                ? explicitContext
                : freezeContext(activeContext),
            cause,
            observedAtUnixMs: now(),
          }) satisfies RequestBoundaryFailure;

          if (options.report !== undefined) {
            try {
              await options.report(failure);
            } catch {
              // A logger/exporter failure must never replace the operation's
              // original failure or escape the protocol boundary.
            }
          }

          return Object.freeze({ ok: false as const, failure });
        }
      });
    },
  };
}
