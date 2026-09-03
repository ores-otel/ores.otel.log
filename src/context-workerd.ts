import type { LogContext, LogContextProvider } from './base-logger.js';
import {
  createLogContextApi,
  getGlobalAsyncLocalStorage,
  SingleFrameLogContextStorage,
  type LogContextStorage,
} from './context-shared.js';

export type { LogContext, LogContextProvider, LogContextStorage };

/**
 * Workerd build. Real async isolation is available with `nodejs_als` or
 * `nodejs_compat`. Without either flag the synchronous fallback restores its
 * frame before async continuation, preventing cross-request identity leakage.
 */
const GlobalAsyncLocalStorage = getGlobalAsyncLocalStorage();
export const logContextStorage: LogContextStorage = GlobalAsyncLocalStorage
  ? new GlobalAsyncLocalStorage()
  : new SingleFrameLogContextStorage();
const api = createLogContextApi(logContextStorage, Boolean(GlobalAsyncLocalStorage));

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
