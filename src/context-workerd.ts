import type { LogContext, LogContextProvider } from './base-logger.js';
import {
  createLogContextApi,
  ExplicitOnlyLogContextStorage,
  getGlobalAsyncLocalStorage,
  type LogContextStorage,
} from './context-shared.js';

export type { LogContext, LogContextProvider, LogContextStorage };

/**
 * Workerd build. Real async isolation is available with `nodejs_als` or
 * `nodejs_compat`. Without it, ambient storage fails closed: callers must pass
 * or capture context explicitly, so overlapping requests can never share a
 * mutable global frame.
 */
const GlobalAsyncLocalStorage = getGlobalAsyncLocalStorage();
export const logContextStorage: LogContextStorage = GlobalAsyncLocalStorage
  ? new GlobalAsyncLocalStorage()
  : new ExplicitOnlyLogContextStorage();
const api = createLogContextApi(logContextStorage, Boolean(GlobalAsyncLocalStorage));

export const isAsyncContextTracked = api.isAsyncContextTracked;
export const runWithLogContext = api.runWithLogContext;
export const runWithMergedLogContext = api.runWithMergedLogContext;
export const getLogContext = api.getLogContext;
export const captureLogContext = api.captureLogContext;
export const runWithCapturedLogContext = api.runWithCapturedLogContext;
export const updateLogContext = api.updateLogContext;
export const setContextLoggedInUser = api.setContextLoggedInUser;
export const logContextProvider = api.logContextProvider;
export const installLogContextProvider = api.installLogContextProvider;
