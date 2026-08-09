import {
  BaseLogger,
  type LogEvent,
  type LogFields,
  type LoggerOptions,
} from './base-logger.js';

// Namespaced re-export: the whole shared surface is reachable as `base.*` from
// every runtime entrypoint, without flattening it into this module's own
// exports (so runtime-specific names can never collide with shared ones).
// A namespace re-export carries types as well as values, so `base.LogLevel`
// works in type position and `base.createLogger` in value position.
export * as base from './base-logger.js';

export interface EdgeExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface EdgeLoggerOptions extends LoggerOptions {
  executionContext?: EdgeExecutionContextLike;
  request?: Request;
}

export class EdgeLogger extends BaseLogger {
  protected declare readonly options: Readonly<EdgeLoggerOptions>;

  constructor(options: EdgeLoggerOptions = {}) {
    super(options, 'edge');
  }

  override getRuntimeFields(): LogFields {
    const request = this.options.request;
    return request
      ? {
          requestUrl: request.url,
          requestMethod: request.method,
        }
      : {};
  }

  override emitEvent(event: LogEvent, store = true): Promise<void> {
    const promise = super.emitEvent(event, store);
    try {
      this.options.executionContext?.waitUntil(promise);
    } catch (error) {
      this.options.onLifecycleError?.(error, 'waitUntil');
    }
    return promise;
  }

  override anew(options: EdgeLoggerOptions = {}): EdgeLogger {
    return new EdgeLogger({
      ...this.options,
      ...options,
      appName: options.appName || this.appName,
      fields: { ...this.fields, ...options.fields },
      loggedInUser: { ...this.getCurrentUser(), ...options.loggedInUser },
    });
  }
}

export function createEdgeLogger(options: EdgeLoggerOptions = {}): EdgeLogger {
  return new EdgeLogger(options);
}

export const edgeLogger = createEdgeLogger();
export { edgeLogger as logger };
export default edgeLogger;
