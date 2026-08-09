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

/**
 * Structural stand-in for workerd's `ExecutionContext`, so this package never
 * has to depend on @cloudflare/workers-types. A real ExecutionContext is
 * assignable to it.
 */
export interface CloudflareExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** The `IncomingRequestCfProperties` fields worth carrying onto a log record. */
export interface CloudflareRequestCfPropertiesLike {
  colo?: string;
  country?: string;
  city?: string;
  region?: string;
  continent?: string;
  postalCode?: string;
  timezone?: string;
  asn?: number;
  asOrganization?: string;
  httpProtocol?: string;
  tlsVersion?: string;
  clientTcpRtt?: number;
  [key: string]: unknown;
}

/** Structural stand-in for a workerd `Request`; a real Request is assignable. */
export interface CloudflareRequestLike {
  url: string;
  method: string;
  headers?: { get(name: string): string | null };
  cf?: CloudflareRequestCfPropertiesLike;
}

/** Structural stand-in for the cron-trigger `ScheduledController`. */
export interface CloudflareScheduledControllerLike {
  scheduledTime: number;
  cron: string;
}

export interface CloudflareWorkerLoggerOptions extends LoggerOptions {
  /**
   * Per-request `ctx`. Delivery is handed to `ctx.waitUntil()` so workerd keeps
   * the isolate alive past the response instead of cancelling in-flight writes.
   */
  executionContext?: CloudflareExecutionContextLike;
  request?: CloudflareRequestLike;
  /** Set on loggers built for a cron trigger rather than a fetch. */
  scheduledController?: CloudflareScheduledControllerLike;
  /**
   * The worker `env` bindings object. Typed as `object` rather than
   * `Record<string, unknown>` because wrangler generates `Env` as an interface,
   * and interfaces have no implicit index signature.
   */
  env?: object;
  /**
   * Names of `env` vars copied onto every record. Only string/number/boolean
   * vars are copied — KV/R2/D1/DO bindings are objects and are skipped.
   * Values still pass through redaction, so a var named `*_TOKEN` is masked.
   */
  envFields?: readonly string[];
  /** Attach colo/geo/network properties from `request.cf` (default true). */
  includeCfProperties?: boolean;
  /** Attach the `cf-connecting-ip` client address (default false; it is PII). */
  includeClientIp?: boolean;
}

const CF_PROPERTY_KEYS = [
  'colo',
  'country',
  'city',
  'region',
  'continent',
  'postalCode',
  'timezone',
  'asn',
  'asOrganization',
  'httpProtocol',
  'tlsVersion',
  'clientTcpRtt',
] as const;

export class CloudflareWorkerLogger extends BaseLogger {
  protected declare readonly options: Readonly<CloudflareWorkerLoggerOptions>;

  constructor(options: CloudflareWorkerLoggerOptions = {}) {
    super(options, 'cloudflare');
  }

  override getRuntimeFields(): LogFields {
    return {
      ...this.getRequestFields(),
      ...this.getScheduledFields(),
      ...this.getEnvFields(),
    };
  }

  private getRequestFields(): LogFields {
    const request = this.options.request;
    if (!request) {
      return {};
    }

    const fields: LogFields = {
      requestUrl: request.url,
      requestMethod: request.method,
    };

    const rayId = request.headers?.get('cf-ray');
    if (rayId) {
      fields.rayId = rayId;
    }
    if (this.options.includeClientIp) {
      const clientIp = request.headers?.get('cf-connecting-ip');
      if (clientIp) {
        fields.clientIp = clientIp;
      }
    }

    if (this.options.includeCfProperties === false || !request.cf) {
      return fields;
    }
    for (const key of CF_PROPERTY_KEYS) {
      const value = request.cf[key];
      if (value !== undefined && value !== null && value !== '') {
        fields[key] = value;
      }
    }
    return fields;
  }

  private getScheduledFields(): LogFields {
    const controller = this.options.scheduledController;
    if (!controller) {
      return {};
    }
    return {
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
    };
  }

  private getEnvFields(): LogFields {
    const { env, envFields } = this.options;
    if (!env || !envFields?.length) {
      return {};
    }
    const bindings = env as Record<string, unknown>;
    const fields: LogFields = {};
    for (const key of envFields) {
      const value = bindings[key];
      const type = typeof value;
      if (type === 'string' || type === 'number' || type === 'boolean') {
        fields[key] = value;
      }
    }
    return fields;
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

  /**
   * Child logger bound to one fetch invocation. A module-scope logger outlives
   * the request but has no `ctx`, so bind per request and log through the
   * child — otherwise delivery races the isolate going idle.
   */
  forRequest(
    request: CloudflareRequestLike,
    executionContext?: CloudflareExecutionContextLike,
    env?: object,
  ): CloudflareWorkerLogger {
    return this.childWithout('scheduledController', {
      request,
      ...(executionContext ? { executionContext } : {}),
      ...(env ? { env } : {}),
    });
  }

  /** Child logger bound to one cron-trigger invocation. */
  forScheduled(
    controller: CloudflareScheduledControllerLike,
    executionContext?: CloudflareExecutionContextLike,
    env?: object,
  ): CloudflareWorkerLogger {
    return this.childWithout('request', {
      scheduledController: controller,
      ...(executionContext ? { executionContext } : {}),
      ...(env ? { env } : {}),
    });
  }

  /**
   * anew() with one inherited invocation binding dropped, so a fetch child of a
   * scheduled logger (or the reverse) does not carry the other trigger's fields.
   * `delete` rather than an `undefined` override, which exactOptionalPropertyTypes rejects.
   */
  private childWithout(
    drop: 'request' | 'scheduledController',
    overrides: CloudflareWorkerLoggerOptions,
  ): CloudflareWorkerLogger {
    const options: CloudflareWorkerLoggerOptions = { ...this.options, ...overrides };
    delete options[drop];
    return new CloudflareWorkerLogger({
      ...options,
      appName: this.appName,
      fields: { ...this.fields },
      loggedInUser: { ...this.getCurrentUser() },
    });
  }

  override anew(options: CloudflareWorkerLoggerOptions = {}): CloudflareWorkerLogger {
    return new CloudflareWorkerLogger({
      ...this.options,
      ...options,
      appName: options.appName || this.appName,
      fields: { ...this.fields, ...options.fields },
      loggedInUser: { ...this.getCurrentUser(), ...options.loggedInUser },
    });
  }
}

export function createCloudflareWorkerLogger(
  options: CloudflareWorkerLoggerOptions = {},
): CloudflareWorkerLogger {
  return new CloudflareWorkerLogger(options);
}

export const cloudflareWorkerLogger = createCloudflareWorkerLogger();
export { cloudflareWorkerLogger as logger };
export default cloudflareWorkerLogger;
