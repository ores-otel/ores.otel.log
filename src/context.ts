import { AsyncLocalStorage } from 'node:async_hooks';

import type { LogContext, LogContextProvider } from './base-logger.js';
import { createLogContextApi, type LogContextStorage } from './context-shared.js';

export type { LogContext, LogContextProvider, LogContextStorage };

/**
 * AsyncLocalStorage-backed ambient log context.
 *
 * Runtime support for `node:async_hooks`:
 *   - Node.js       — native.
 *   - Bun           — implements node:async_hooks AsyncLocalStorage.
 *   - Deno          — implements node:async_hooks AsyncLocalStorage.
 *   - Vercel edge   — available (edge-light); resolves here.
 *   - workerd       — needs the nodejs_als or nodejs_compat flag, so the
 *                     package's `workerd` export condition sends that runtime
 *                     to context-workerd.js, which probes for the global
 *                     instead of importing node:async_hooks (a static import
 *                     throws at module evaluation when the flag is absent).
 *   - Browsers      — resolve to context-browser.js via the `browser` condition.
 *
 * The import above is deliberately static: on every runtime routed here the
 * module exists, and a static import keeps this file free of top-level await
 * (which some bundlers still refuse to inline).
 */
export const logContextStorage: LogContextStorage = new AsyncLocalStorage<LogContext>();

const api = createLogContextApi(logContextStorage, true);

/**
 * True when the active storage isolates concurrent async flows. Always true
 * here; the browser and unflagged-workerd builds report false so callers can
 * detect the degraded single-frame fallback.
 */
export const isAsyncContextTracked = api.isAsyncContextTracked;

/** Runs callback with the given context active; nested calls shadow outer frames. */
export const runWithLogContext = api.runWithLogContext;

export const getLogContext = api.getLogContext;

/**
 * Shallow-merges a patch into the live context frame (objects merge, arrays
 * append and dedupe). Returns false when no frame is active.
 */
export const updateLogContext = api.updateLogContext;

/** Convenience for the most common patch: recording who is acting. */
export const setContextLoggedInUser = api.setContextLoggedInUser;

/** A provider reading this module's storage, suitable for setLogContextProvider or logger options. */
export const logContextProvider = api.logContextProvider;

/**
 * Makes every logger in the process read this module's storage.
 * Returns an uninstall function that restores the previous provider.
 */
export const installLogContextProvider = api.installLogContextProvider;
