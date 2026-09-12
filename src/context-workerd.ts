import type { LogContext, LogContextProvider } from './base-logger.js';
import {
  createLogContextApi,
  ExplicitOnlyLogContextStorage,
  getGlobalAsyncLocalStorage,
  type LogContextStorage,
} from './context-shared.js';
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
 * Workerd build. Real async isolation is available with `nodejs_als` or
 * `nodejs_compat`. Without either flag, ambient context is unavailable and
 * fails closed: callers must retain an explicit request logger or pass an
 * immutable context snapshot, so overlapping requests cannot share identity.
 */
const GlobalAsyncLocalStorage = getGlobalAsyncLocalStorage();
export const logContextStorage: LogContextStorage = GlobalAsyncLocalStorage
  ? new GlobalAsyncLocalStorage()
  : new ExplicitOnlyLogContextStorage();
const api = createLogContextApi(logContextStorage, Boolean(GlobalAsyncLocalStorage));
const requestBoundaryApi = createRequestBoundaryApi(api);

export const isAsyncContextTracked = api.isAsyncContextTracked;
export const runWithLogContext = api.runWithLogContext;
export const runWithMergedLogContext = api.runWithMergedLogContext;
export const getLogContext = api.getLogContext;
export const currentLogRequestId = api.currentLogRequestId;
export const currentLogTraceId = api.currentLogTraceId;
export const currentLogUserId = api.currentLogUserId;
export const currentLogLoggedInUserId = api.currentLogLoggedInUserId;
export const currentLogTenantId = api.currentLogTenantId;
export const captureLogContext = api.captureLogContext;
export const runWithCapturedLogContext = api.runWithCapturedLogContext;
export const updateLogContext = api.updateLogContext;
export const setContextLoggedInUser = api.setContextLoggedInUser;
export const logContextProvider = api.logContextProvider;
export const installLogContextProvider = api.installLogContextProvider;
/**
 * Without native ALS, the returned failure still carries the explicit request
 * snapshot while ambient lookups remain disabled to prevent cross-request bleed.
 */
export const runWithRequestBoundary = requestBoundaryApi.runWithRequestBoundary;
