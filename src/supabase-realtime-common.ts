import type { LogRecord, WebSocketFactory } from './base-logger.js';

export type SupabaseAccessToken =
  | string
  | (() => string | undefined | Promise<string | undefined>);

export type SupabaseRealtimeDropReason =
  | 'queue-full'
  | 'closed'
  | 'delivery-failed'
  | 'record-too-large';

export interface SupabaseRealtimeDrop {
  reason: SupabaseRealtimeDropReason;
  record: LogRecord;
  droppedTotal: number;
}

export interface SupabaseRealtimeSnapshot {
  queued: number;
  inFlight: number;
  acknowledged: number;
  failures: number;
  dropped: number;
  reconnectAttempts: number;
  connected: boolean;
  joined: boolean;
  accepting: boolean;
  closed: boolean;
}

export interface SupabaseRealtimeAckOptions {
  url: string;
  publishableKey: string;
  accessToken?: SupabaseAccessToken;
  allowUnauthenticated?: boolean;
  channel?: string;
  event?: string;
  privateChannel?: boolean;
  maxQueueSize?: number;
  maxInFlight?: number;
  maxAttempts?: number;
  connectTimeoutMillis?: number;
  ackTimeoutMillis?: number;
  heartbeatMillis?: number;
  heartbeatTimeoutMillis?: number;
  flushTimeoutMillis?: number;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  /**
   * Records larger than this are dropped rather than wedging the queue.
   * Realtime rejects frames above roughly 256 KiB, and a frame it refuses is
   * indistinguishable from one that was never acknowledged, so an oversized
   * record would otherwise retry until it exhausted maxAttempts. Default
   * 128 KiB.
   */
  maxRecordBytes?: number;
  /**
   * Re-resolve the access token this long before its `exp` and push it over
   * the joined channel. Default 60s. Without it a token is only ever resolved
   * at join, so a session outliving its JWT keeps a socket the server will
   * reject and the callback is not consulted again until a reconnect.
   */
  tokenRefreshLeadMillis?: number;
  /** Flush on pagehide/visibilitychange:hidden/freeze. Default true. */
  flushOnPageHide?: boolean;
  /** Retry immediately on online/focus/visible instead of waiting out the backoff. Default true. */
  resumeOnUserSignals?: boolean;
  retryBaseMillis?: number;
  retryMaxMillis?: number;
  random?: () => number;
  awaitDelivery?: boolean;
  webSocketFactory?: WebSocketFactory;
  onDrop?: (drop: SupabaseRealtimeDrop) => void;
  onError?: (error: unknown, snapshot: SupabaseRealtimeSnapshot) => void;
}

export interface SupabaseSessionIdentity {
  appName: string;
  sessionId: string;
  channel?: string;
}

export type Waiter = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};
export type Pending = { record: LogRecord; attempts: number; waiter?: Waiter };
export type InFlight = { pending: Pending; timer: ReturnType<typeof setTimeout> };
export type IdleWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};
export type Reply = {
  topic?: string;
  event?: string;
  ref?: string;
  payload?: { status?: string; response?: unknown };
};

export const numberOption = (
  value: number | undefined,
  fallback: number,
  minimum = 1,
): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.floor(value));

export const unref = (timer: unknown): void => {
  (timer as { unref?: () => void } | null)?.unref?.();
};

export const createWaiter = (): Waiter => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const identityPart = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new TypeError(`${label} must contain between 1 and 128 characters`);
  }
  return normalized;
};

export function createSupabaseSessionChannel(identity: SupabaseSessionIdentity): string {
  const app = identityPart(identity.appName, 'session.appName');
  const session = identityPart(identity.sessionId, 'session.sessionId');
  return `next-loggers:${encodeURIComponent(app)}:${encodeURIComponent(session)}`;
}

export const realtimeUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Supabase Realtime url must be valid, got: ${value}`);
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError(`Supabase Realtime requires http(s) or ws(s), got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new TypeError('Supabase Realtime url must not contain embedded credentials');
  }
  // The apikey is appended deliberately at connect time; nothing else belongs
  // in a URL that ends up in proxy and CDN logs.
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/websocket')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/realtime/v1/websocket`;
  }
  return url.toString();
};

/**
 * Decode base64url without atob.
 *
 * This used to call `globalThis.atob` and return undefined when it was absent
 * — which made the service-role check below fail OPEN in any runtime without
 * it. A guard that silently passes in some runtimes is worse than no guard,
 * because it reads as protection everywhere.
 */
const decodeBase64Url = (value: string): string | undefined => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) return undefined;
    buffer = (buffer << 6) | index;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
    buffer &= bits === 0 ? 0 : (1 << bits) - 1;
  }
  try {
    return typeof TextDecoder === 'function'
      ? new TextDecoder().decode(Uint8Array.from(bytes))
      : String.fromCharCode(...bytes);
  } catch {
    return undefined;
  }
};

const jwtClaims = (value: string): Record<string, unknown> | undefined => {
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const decoded = decodeBase64Url(parts[1]);
    return decoded ? (JSON.parse(decoded) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const jwtRole = (value: string): string | undefined => {
  const role = jwtClaims(value)?.role;
  return typeof role === 'string' ? role : undefined;
};

/** Expiry as epoch milliseconds, or undefined for an opaque key. */
export const jwtExpiryMillis = (value: string): number | undefined => {
  const exp = jwtClaims(value)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1_000 : undefined;
};

/** UTF-8 byte length, for the frame-size caps Realtime enforces. */
export const byteLength = (value: string): number =>
  typeof TextEncoder === 'function' ? new TextEncoder().encode(value).byteLength : value.length;

export const assertClientCredential = (value: string, label: string): void => {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  if (!normalized) throw new TypeError(`${label} must not be empty`);
  if (
    lower.startsWith('sb_secret_') ||
    lower === 'service_role' ||
    lower.includes('service-role') ||
    jwtRole(normalized)?.toLowerCase() === 'service_role'
  ) {
    throw new TypeError(`${label} must be a publishable or user-scoped credential`);
  }
};
