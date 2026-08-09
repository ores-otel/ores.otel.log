import type { LogContext, LogContextProvider } from './base-logger.js';
import {
  createLogContextApi,
  getGlobalAsyncLocalStorage,
  SingleFrameLogContextStorage,
  type LogContextStorage,
} from './context-shared.js';

export type { LogContext, LogContextProvider, LogContextStorage };

/**
 * Cloudflare Workers build of `@oresoftware/next-loggers/context`, selected by the
 * package's `workerd` export condition.
 *
 * workerd only provides AsyncLocalStorage when the `nodejs_als` (or
 * `nodejs_compat`) compatibility flag is set. A static `node:async_hooks`
 * import would therefore throw during module evaluation on an unflagged
 * Worker — taking the whole isolate down at startup, before any logging call.
 * So this probes for the global instead and degrades to the single-frame
 * fallback when it is absent.
 *
 * Enable real async context tracking in wrangler.toml:
 *   compatibility_flags = ["nodejs_als"]
 */
const GlobalAsyncLocalStorage = getGlobalAsyncLocalStorage();

export const logContextStorage: LogContextStorage = GlobalAsyncLocalStorage
  ? new GlobalAsyncLocalStorage()
  : new SingleFrameLogContextStorage();

const api = createLogContextApi(logContextStorage, Boolean(GlobalAsyncLocalStorage));

/**
 * True when the Worker was deployed with nodejs_als/nodejs_compat. False means
 * the single-frame fallback is active and concurrent requests in one isolate
 * can observe each other's context — check this before relying on per-request
 * isolation.
 */
export const isAsyncContextTracked = api.isAsyncContextTracked;

export const runWithLogContext = api.runWithLogContext;
export const getLogContext = api.getLogContext;
export const updateLogContext = api.updateLogContext;
export const setContextLoggedInUser = api.setContextLoggedInUser;
export const logContextProvider = api.logContextProvider;
export const installLogContextProvider = api.installLogContextProvider;
