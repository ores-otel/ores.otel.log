import { AsyncLocalStorage } from 'node:async_hooks';

import type { LogContext, LogContextProvider } from './base-logger.js';
import { createLogContextApi, type LogContextStorage } from './context-shared.js';
import { createRequestBoundaryApi } from './request-boundary.js';

export type { LogContext, LogContextProvider, LogContextStorage };
export {
  httpRequestBoundary,
  requestFailureKinds,
  tcpConnectionBoundary,
  tcpMessageBoundary,
  webSocketMessageBoundary,
  webSocketSessionBoundary,
} from './request-boundary.js';
export type {
  RequestBoundary,
  RequestBoundaryApi,
  RequestBoundaryFailure,
  RequestBoundaryOptions,
  RequestBoundaryResult,
  RequestFailureKind,
} from './request-boundary.js';

/**
 * AsyncLocalStorage-backed ambient log context for Node, Bun, Deno, and
 * compatible edge runtimes. Workerd and browsers resolve to dedicated builds.
 */
export const logContextStorage: LogContextStorage = new AsyncLocalStorage<LogContext>();

const api = createLogContextApi(logContextStorage, true);
const requestBoundaryApi = createRequestBoundaryApi(api);

export const isAsyncContextTracked = api.isAsyncContextTracked;
/** Runs callback with the exact context active; nested calls shadow outer frames. */
export const runWithLogContext = api.runWithLogContext;
/** Runs callback with a patch merged over the active frame. */
export const runWithMergedLogContext = api.runWithMergedLogContext;
export const getLogContext = api.getLogContext;
/** O(1) canonical request ID lookup from fields['request.id']. */
export const currentLogRequestId = api.currentLogRequestId;
/** O(1) trace ID lookup from the active logging scope. */
export const currentLogTraceId = api.currentLogTraceId;
/** O(1) canonical authenticated user ID lookup. */
export const currentLogUserId = api.currentLogUserId;
export const currentLogLoggedInUserId = api.currentLogLoggedInUserId;
/** O(1) canonical tenant ID lookup from fields['tenant.id']. */
export const currentLogTenantId = api.currentLogTenantId;
/** Captures a defensive frame for queues, callbacks, and detached tasks. */
export const captureLogContext = api.captureLogContext;
/** Re-enters a previously captured frame. */
export const runWithCapturedLogContext = api.runWithCapturedLogContext;
export const updateLogContext = api.updateLogContext;
export const setContextLoggedInUser = api.setContextLoggedInUser;
export const logContextProvider = api.logContextProvider;
export const installLogContextProvider = api.installLogContextProvider;
/**
 * Runs one HTTP, TCP, or WebSocket operation inside this runtime's canonical
 * context and returns a discriminated failure instead of installing a global
 * crash hook.
 */
export const runWithRequestBoundary = requestBoundaryApi.runWithRequestBoundary;
