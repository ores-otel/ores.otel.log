import type { LogRecord, WebSocketFactory } from './base-logger.js';

export type SupabaseAccessToken =
  | string
  | (() => string | undefined | Promise<string | undefined>);

export type SupabaseRealtimeDropReason = 'queue-full' | 'closed' | 'delivery-failed';

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
  if (!url.pathname.endsWith('/websocket')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/realtime/v1/websocket`;
  }
  return url.toString();
};

const jwtRole = (value: string): string | undefined => {
  const payload = value.split('.')[1];
  if (value.split('.').length !== 3 || !payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decode = (globalThis as { atob?: (input: string) => string }).atob;
    if (!decode) return undefined;
    const parsed = JSON.parse(decode(padded)) as { role?: unknown };
    return typeof parsed.role === 'string' ? parsed.role : undefined;
  } catch {
    return undefined;
  }
};

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
