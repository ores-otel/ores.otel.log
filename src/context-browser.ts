import type { LogContext, LogContextProvider } from './base-logger.js';
import {
  createLogContextApi,
  SingleFrameLogContextStorage,
  type LogContextStorage,
} from './context-shared.js';

export type { LogContext, LogContextProvider, LogContextStorage };

/**
 * Browser build of `@oresoftware/next-loggers/context`.
 * The fallback supports synchronous enrichment only. It deliberately restores
 * the frame before an async continuation can run so overlapping operations
 * cannot observe each other's request or user identity. Use an explicit child
 * logger or application-owned provider after `await`.
 */
export const logContextStorage: LogContextStorage = new SingleFrameLogContextStorage();
const api = createLogContextApi(logContextStorage, false);

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
