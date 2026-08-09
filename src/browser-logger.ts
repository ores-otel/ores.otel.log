import {
  BaseLogger,
  type FlushOptions,
  type LogFields,
  type LoggerOptions,
} from './base-logger.js';
import {
  BrowserStreamTransport,
  type BrowserStreamOptions,
} from './browser-stream.js';

export {
  BrowserStreamTransport,
  createBrowserStreamTransport,
  type BrowserStreamOptions,
  type StreamSocketLike,
} from './browser-stream.js';

// Namespaced re-export: the whole shared surface is reachable as `base.*` from
// every runtime entrypoint, without flattening it into this module's own
// exports (so runtime-specific names can never collide with shared ones).
// A namespace re-export carries types as well as values, so `base.LogLevel`
// works in type position and `base.createLogger` in value position.
export * as base from './base-logger.js';

export interface BrowserLoggerOptions extends LoggerOptions {
  includePageContext?: boolean;
  /** Adds screen, viewport, timezone and connection fields to every record. */
  includeDeviceContext?: boolean;
  captureGlobalErrors?: boolean;
  captureUnhandledRejections?: boolean;
  /** Also report CSP violations (securitypolicyviolation) as WARN records. */
  captureCspViolations?: boolean;
  flushOnUnload?: boolean;
  shutdownTimeoutMillis?: number;
  /**
   * Streams records out over a batched, buffered WebSocket. Point it at a
   * Supabase Realtime socket, your own collector, or wrap an existing
   * transport — see BrowserStreamOptions.
   */
  stream?: BrowserStreamOptions;
}

const registeredBrowserLoggers = new Set<BrowserLogger>();
let unloadHandlersInstalled = false;

const flushBrowserLoggers = (): void => {
  for (const logger of registeredBrowserLoggers) {
    void logger.flushOnExit({ timeoutMillis: logger.shutdownTimeoutMillis });
  }
};

function installUnloadHandlers(): void {
  if (unloadHandlersInstalled || typeof globalThis.addEventListener !== 'function') {
    return;
  }
  unloadHandlersInstalled = true;
  globalThis.addEventListener('pagehide', flushBrowserLoggers);
  globalThis.addEventListener('beforeunload', flushBrowserLoggers);
  globalThis.addEventListener('unload', flushBrowserLoggers);
}

function removeUnloadHandlers(): void {
  if (!unloadHandlersInstalled || typeof globalThis.removeEventListener !== 'function') {
    return;
  }
  unloadHandlersInstalled = false;
  globalThis.removeEventListener('pagehide', flushBrowserLoggers);
  globalThis.removeEventListener('beforeunload', flushBrowserLoggers);
  globalThis.removeEventListener('unload', flushBrowserLoggers);
}

function registerBrowserLogger(logger: BrowserLogger): void {
  registeredBrowserLoggers.add(logger);
  installUnloadHandlers();
}

function unregisterBrowserLogger(logger: BrowserLogger): void {
  registeredBrowserLoggers.delete(logger);
  if (registeredBrowserLoggers.size === 0) {
    removeUnloadHandlers();
  }
}

export class BrowserLogger extends BaseLogger {
  protected declare readonly options: Readonly<BrowserLoggerOptions>;

  private removeGlobalHandlers: (() => void) | null = null;
  private unloadRegistered = false;
  readonly streamTransport: BrowserStreamTransport | null;

  constructor(options: BrowserLoggerOptions = {}) {
    super(options, 'browser');
    this.streamTransport = options.stream ? new BrowserStreamTransport(options.stream) : null;
    if (this.streamTransport) {
      this.transports.push(this.streamTransport);
    }
    if (
      options.captureGlobalErrors ||
      options.captureUnhandledRejections ||
      options.captureCspViolations
    ) {
      this.installGlobalHandlers();
    }
    if (options.flushOnUnload !== false) {
      registerBrowserLogger(this);
      this.unloadRegistered = true;
    }
  }

  get shutdownTimeoutMillis(): number {
    return this.options.shutdownTimeoutMillis ?? 2_000;
  }

  override getRuntimeFields(): LogFields {
    return {
      ...(this.options.includePageContext === false ? {} : this.getPageFields()),
      ...(this.options.includeDeviceContext ? this.getDeviceFields() : {}),
    };
  }

  private getPageFields(): LogFields {
    return {
      ...(typeof location !== 'undefined'
        ? {
            url: location.href,
            origin: location.origin,
            path: `${location.pathname}${location.search}`,
          }
        : {}),
      ...(typeof navigator !== 'undefined'
        ? {
            userAgent: navigator.userAgent,
            language: navigator.language,
            online: navigator.onLine,
          }
        : {}),
      ...(typeof document !== 'undefined' ? { referrer: document.referrer } : {}),
    };
  }

  /**
   * Device shape, for correlating incidents with a viewport or a slow radio.
   * Every read is guarded: privacy extensions throw on some of these getters.
   */
  private getDeviceFields(): LogFields {
    const fields: LogFields = {};
    try {
      if (typeof screen !== 'undefined') {
        fields.screenWidth = screen.width;
        fields.screenHeight = screen.height;
        fields.orientation = screen.orientation?.type;
      }
      if (typeof window !== 'undefined') {
        fields.windowWidth = window.innerWidth;
        fields.windowHeight = window.innerHeight;
        fields.pixelRatio = window.devicePixelRatio;
      }
      if (typeof Intl !== 'undefined') {
        fields.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      }
      const connection = (
        globalThis as { navigator?: { connection?: { effectiveType?: string } } }
      ).navigator?.connection;
      if (connection?.effectiveType) {
        fields.connectionType = connection.effectiveType;
      }
    } catch {
      // Partial device context beats losing the record.
    }
    return fields;
  }

  override anew(options: BrowserLoggerOptions = {}): BrowserLogger {
    return new BrowserLogger({
      ...this.options,
      ...options,
      appName: options.appName || this.appName,
      fields: { ...this.fields, ...options.fields },
      loggedInUser: { ...this.getCurrentUser(), ...options.loggedInUser },
    });
  }

  installGlobalHandlers(): () => void {
    if (this.removeGlobalHandlers || typeof globalThis.addEventListener !== 'function') {
      return this.removeGlobalHandlers || (() => undefined);
    }

    const errorHandler = (event: Event): void => {
      const errorEvent = event as ErrorEvent;
      void this.error(errorEvent.message || 'Unhandled browser error', errorEvent.error)
        .addFields({
          filename: errorEvent.filename,
          line: errorEvent.lineno,
          column: errorEvent.colno,
        })
        .addTags('browser', 'uncaught-error')
        .captureStackTrace()
        .send();
    };
    const rejectionHandler = (event: Event): void => {
      const rejectionEvent = event as PromiseRejectionEvent;
      void this.error('Unhandled browser promise rejection', rejectionEvent.reason)
        .addTags('browser', 'unhandled-rejection')
        .captureStackTrace()
        .send();
    };

    const cspHandler = (event: Event): void => {
      const violation = event as SecurityPolicyViolationEvent;
      void this.warn('Content Security Policy violation', violation.violatedDirective)
        .addFields({
          blockedURI: violation.blockedURI,
          sourceFile: violation.sourceFile,
          line: violation.lineNumber,
        })
        .addTags('browser', 'csp-violation')
        .send();
    };

    if (this.options.captureGlobalErrors) {
      globalThis.addEventListener('error', errorHandler);
    }
    if (this.options.captureUnhandledRejections) {
      globalThis.addEventListener('unhandledrejection', rejectionHandler);
    }
    if (this.options.captureCspViolations) {
      globalThis.addEventListener('securitypolicyviolation', cspHandler);
    }

    this.removeGlobalHandlers = () => {
      if (this.options.captureGlobalErrors) {
        globalThis.removeEventListener('error', errorHandler);
      }
      if (this.options.captureUnhandledRejections) {
        globalThis.removeEventListener('unhandledrejection', rejectionHandler);
      }
      if (this.options.captureCspViolations) {
        globalThis.removeEventListener('securitypolicyviolation', cspHandler);
      }
      this.removeGlobalHandlers = null;
    };
    return this.removeGlobalHandlers;
  }

  installUnloadHandlers(): () => void {
    if (!this.unloadRegistered) {
      registerBrowserLogger(this);
      this.unloadRegistered = true;
    }
    return () => {
      if (this.unloadRegistered) {
        unregisterBrowserLogger(this);
        this.unloadRegistered = false;
      }
    };
  }

  override async close(options: FlushOptions = {}): Promise<void> {
    this.removeGlobalHandlers?.();
    if (this.unloadRegistered) {
      unregisterBrowserLogger(this);
      this.unloadRegistered = false;
    }
    await super.close(options);
  }
}

export function createBrowserLogger(options: BrowserLoggerOptions = {}): BrowserLogger {
  return new BrowserLogger(options);
}

export const browserLogger = createBrowserLogger();
export { browserLogger as logger };
export default browserLogger;
