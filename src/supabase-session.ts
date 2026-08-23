import type { LogRecord, LogTransport } from './base-logger.js';
import {
  createSupabaseIngestTransport,
  type SupabaseIngestOptions,
  type SupabaseIngestSnapshot,
  type SupabaseIngestTransport,
} from './supabase-ingest.js';
import {
  createSupabaseSessionChannel,
  SupabaseRealtimeAckTransport,
  type SupabaseAccessToken,
  type SupabaseRealtimeAckOptions,
  type SupabaseRealtimeSnapshot,
  type SupabaseSessionIdentity,
} from './supabase-realtime.js';

export type {
  SupabaseAccessToken,
  SupabaseRealtimeAckOptions,
  SupabaseRealtimeDrop,
  SupabaseRealtimeDropReason,
  SupabaseRealtimeSnapshot,
  SupabaseSessionIdentity,
} from './supabase-realtime.js';
export {
  createSupabaseRealtimeAckTransport,
  createSupabaseSessionChannel,
  SupabaseRealtimeAckTransport,
} from './supabase-realtime.js';

export interface SupabaseSessionTransportOptions {
  url: string;
  publishableKey: string;
  accessToken?: SupabaseAccessToken;
  session: SupabaseSessionIdentity;
  allowUnauthenticated?: boolean;
  realtime?:
    | false
    | Omit<
        SupabaseRealtimeAckOptions,
        'url' | 'publishableKey' | 'accessToken' | 'allowUnauthenticated'
      >;
  ingest?:
    | false
    | Omit<
        SupabaseIngestOptions,
        'url' | 'publishableKey' | 'accessToken' | 'allowUnauthenticated'
      >;
  onRealtimeError?: (error: unknown, snapshot: SupabaseRealtimeSnapshot) => void;
}

export interface SupabaseSessionSnapshot {
  realtime?: SupabaseRealtimeSnapshot;
  ingest?: SupabaseIngestSnapshot;
}

const identityPart = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new TypeError(`${label} must contain between 1 and 128 characters`);
  }
  return normalized;
};

/**
 * Mirrors already-redacted records to acknowledged Realtime and authenticated
 * durable ingest. Realtime failure never negates a successful durable write.
 */
export class SupabaseSessionTransport implements LogTransport {
  readonly name = 'supabase-session';
  readonly realtime: SupabaseRealtimeAckTransport | null;
  readonly ingest: SupabaseIngestTransport | null;
  readonly options: Readonly<SupabaseSessionTransportOptions>;
  private readonly appName: string;
  private readonly sessionId: string;

  constructor(options: SupabaseSessionTransportOptions) {
    if (options.realtime === false && options.ingest === false) {
      throw new TypeError('SupabaseSessionTransport requires realtime or ingest');
    }
    this.options = options;
    this.appName = identityPart(options.session.appName, 'session.appName');
    this.sessionId = identityPart(options.session.sessionId, 'session.sessionId');
    const common = {
      url: options.url,
      publishableKey: options.publishableKey,
      ...(options.accessToken !== undefined ? { accessToken: options.accessToken } : {}),
      ...(options.allowUnauthenticated !== undefined
        ? { allowUnauthenticated: options.allowUnauthenticated }
        : {}),
    };

    if (options.realtime === false) {
      this.realtime = null;
    } else {
      const realtime = options.realtime ?? {};
      const consumerError = realtime.onError;
      this.realtime = new SupabaseRealtimeAckTransport({
        ...common,
        ...realtime,
        channel:
          realtime.channel?.trim() ||
          options.session.channel?.trim() ||
          createSupabaseSessionChannel(options.session),
        onError: (error, snapshot) => {
          try {
            consumerError?.(error, snapshot);
          } catch {
            // Consumer diagnostics are isolated.
          }
          try {
            options.onRealtimeError?.(error, snapshot);
          } catch {
            // Session diagnostics cannot destabilize durable ingest.
          }
        },
      });
    }
    this.ingest =
      options.ingest === false
        ? null
        : createSupabaseIngestTransport({ ...common, ...(options.ingest ?? {}) });
  }

  snapshot(): SupabaseSessionSnapshot {
    return {
      ...(this.realtime ? { realtime: this.realtime.snapshot() } : {}),
      ...(this.ingest ? { ingest: this.ingest.snapshot() } : {}),
    };
  }

  private prepare(record: LogRecord): LogRecord {
    if (record.appName !== this.appName) {
      throw new TypeError(
        `Supabase session transport expected appName ${this.appName}, got ${record.appName}`,
      );
    }
    return { ...record, fields: { ...record.fields, sessionId: this.sessionId } };
  }

  async write(record: LogRecord): Promise<void> {
    const prepared = this.prepare(record);
    const live = this.realtime?.write(prepared).catch(() => undefined);
    if (this.ingest) await this.ingest.write(prepared);
    else await live;
    await live;
  }

  async flush(): Promise<void> {
    const live = this.realtime?.flush().catch(() => undefined);
    if (this.ingest) await this.ingest.flush();
    else await live;
    await live;
  }

  async flushOnExit(records: readonly LogRecord[]): Promise<void> {
    const live = this.realtime?.flushOnExit(records).catch(() => undefined);
    if (this.ingest) await this.ingest.flushOnExit();
    else await live;
    await live;
  }

  async close(): Promise<void> {
    const live = this.realtime?.close().catch(() => undefined);
    if (this.ingest) await this.ingest.close();
    else await live;
    await live;
  }
}

export const createSupabaseSessionTransport = (
  options: SupabaseSessionTransportOptions,
): SupabaseSessionTransport => new SupabaseSessionTransport(options);
