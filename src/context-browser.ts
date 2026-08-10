import type { LogContext, LogContextProvider } from './base-logger.js';
import {
  createLogContextApi,
  SingleFrameLogContextStorage,
  type LogContextStorage,
} from './context-shared.js';

export type { LogContext, LogContextProvider, LogContextStorage };

/**
 * Browser build of `@oresoftware/next-loggers/context`.
 * The fallback is safe for sequential work but cannot isolate overlapping
 * async flows. Check `isAsyncContextTracked()` before relying on request-local
 * isolation, or install an application-owned context provider.
 */
export const logContextStorage: LogContextStorage = new SingleFrameLogContextStorage();
const api = createLogContextApi(logContextStorage, false);

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
