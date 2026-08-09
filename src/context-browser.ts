import type { LogContext, LogContextProvider } from './base-logger.js';
import {
  createLogContextApi,
  SingleFrameLogContextStorage,
  type LogContextStorage,
} from './context-shared.js';

export type { LogContext, LogContextProvider, LogContextStorage };

/**
 * Browser build of `@oresoftware/next-loggers/context`, selected by the package's
 * `browser` export condition.
 *
 * Browsers have no AsyncLocalStorage, so this keeps a single module-scoped
 * frame: correct for sequential work, but it cannot isolate overlapping async
 * flows — see SingleFrameLogContextStorage. isAsyncContextTracked() returns
 * false here so callers can detect the degradation instead of assuming
 * per-request isolation. Apps with real zone tracking (e.g. Angular zones) can
 * attach their own store via logger.setALS() or setLogContextProvider().
 */
export const logContextStorage: LogContextStorage = new SingleFrameLogContextStorage();

const api = createLogContextApi(logContextStorage, false);

/** Always false in browsers: the fallback storage cannot isolate concurrent flows. */
export const isAsyncContextTracked = api.isAsyncContextTracked;

export const runWithLogContext = api.runWithLogContext;
export const getLogContext = api.getLogContext;
export const updateLogContext = api.updateLogContext;
export const setContextLoggedInUser = api.setContextLoggedInUser;
export const logContextProvider = api.logContextProvider;
export const installLogContextProvider = api.installLogContextProvider;
