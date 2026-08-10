import { AsyncLocalStorage } from 'node:async_hooks';

import type { LogContext, LogContextProvider } from './base-logger.js';
import { createLogContextApi, type LogContextStorage } from './context-shared.js';

export type { LogContext, LogContextProvider, LogContextStorage };

/**
 * AsyncLocalStorage-backed ambient log context for Node, Bun, Deno, and
 * compatible edge runtimes. Workerd and browsers resolve to dedicated builds.
 */
export const logContextStorage: LogContextStorage = new AsyncLocalStorage<LogContext>();

const api = createLogContextApi(logContextStorage, true);

export const isAsyncContextTracked = api.isAsyncContextTracked;
/** Runs callback with the exact context active; nested calls shadow outer frames. */
export const runWithLogContext = api.runWithLogContext;
/** Runs callback with a patch merged over the active frame. */
export const runWithMergedLogContext = api.runWithMergedLogContext;
export const getLogContext = api.getLogContext;
/** Captures a defensive frame for queues, callbacks, and detached tasks. */
export const captureLogContext = api.captureLogContext;
/** Re-enters a previously captured frame. */
export const runWithCapturedLogContext = api.runWithCapturedLogContext;
export const updateLogContext = api.updateLogContext;
export const setContextLoggedInUser = api.setContextLoggedInUser;
export const logContextProvider = api.logContextProvider;
export const installLogContextProvider = api.installLogContextProvider;
