import type {
  LogRecord,
  LogTransport,
  WebSocketFactory,
  WebSocketLike,
} from './base-logger.js';

export interface SupabaseRealtimeBatchDrop {
  reason: 'queue-full' | 'record-too-large' | 'closed';
  record: LogRecord;
  droppedTotal: number;
}

export interface SupabaseRealtimeBatchSnapshot {
  queued: number;
  dropped: number;
  failures: number;
  reconnectAttempts: number;
  accepting: boolean;
  connected: boolean;
  joined: boolean;
  closed: boolean;
}

export interface SupabaseRealtimeBatchOptions {
  /** Supabase project URL or complete Realtime WebSocket URL. */
  url: string;
  /** Client-safe sb_publishable_* key. A legacy anon key also works during migration. */
  publishableKey: string;
  /** Current user JWT. A service-role or sb_secret_* credential is always rejected. */
  accessToken?: string | (() => string | undefined | Promise<string | undefined>);
  /**
   * Authenticated private channels are the safe default. Enable this only for a
   * deliberately public, publishable-key-only telemetry gateway.
   */
  allowUnauthenticated?: boolean;
  /** Private Realtime topic without the `realtime:` prefix. */
  channel: string;
  event?: string;
  privateChannel?: boolean;
  batchSize?: number;
  maxQueueSize?: number;
  maxRecordBytes?: number;
  maxBatchBytes?: number;
  flushIntervalMillis?: number;
  connectTimeoutMillis?: number;
  ackTimeoutMillis?: number;
  heartbeatMillis?: number;
  retryBaseMillis?: number;
  retryMaxMillis?: number;
  /** Number of consecutive WebSocket failures before a configured fallback is used. */
  fallbackAfterFailures?: number;
  fallback?: LogTransport;
  awaitDelivery?: boolean;
  webSocketFactory?: WebSocketFactory;
  clock?: () => Date;
  random?: () => number;
  onDrop?: (drop: SupabaseRealtimeBatchDrop) => void;
  onError?: (error: unknown, snapshot: SupabaseRealtimeBatchSnapshot) => void;
}

type PhoenixMessage = {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: string;
  join_ref?: string;
};

type PendingReply = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type QueuedRecord = {
  record: LogRecord;
  encoded: string;
  bytes: number;
};

type ResolvedOptions = {
  batchSize: number;
  maxQueueSize: number;
  maxRecordBytes: number;
  maxBatchBytes: number;
  flushIntervalMillis: number;
  connectTimeoutMillis: number;
  ackTimeoutMillis: number;
  heartbeatMillis: number;
  retryBaseMillis: number;
  retryMaxMillis: number;
  fallbackAfterFailures: number;
};

const BATCH_SCHEMA = 'next-loggers/realtime-batch/v1';
const BATCH_ENVELOPE_BYTES = 768;
const DEFAULTS: ResolvedOptions = {
  batchSize: 40,
  maxQueueSize: 2_000,
  maxRecordBytes: 128 * 1_024,
  maxBatchBytes: 240 * 1_024,
  flushIntervalMillis: 750,
  connectTimeoutMillis: 8_000,
  ackTimeoutMillis: 8_000,
  heartbeatMillis: 25_000,
  retryBaseMillis: 500,
  retryMaxMillis: 30_000,
  fallbackAfterFailures: 3,
};

class CursorQueue<T> {
  private values: T[] = [];
  private head = 0;

  get length(): number {
    return this.values.length - this.head;
  }

  push(value: T): void {
    this.values.push(value);
  }

  shift(): T | undefined {
    if (this.head >= this.values.length) return undefined;
    const value = this.values[this.head];
    this.head += 1;
    if (this.head > 1_024 && this.head * 2 > this.values.length) {
      this.values = this.values.slice(this.head);
      this.head = 0;
    }
    return value;
  }

  pop(): T | undefined {
    if (this.head >= this.values.length) return undefined;
    const value = this.values.pop();
    if (this.head >= this.values.length) {
      this.values = [];
      this.head = 0;
    }
    return value;
  }

  prepend(values: readonly T[]): void {
    if (values.length === 0) return;
    this.values = [...values, ...this.values.slice(this.head)];
    this.head = 0;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function byteLength(value: string): number {
  return typeof TextEncoder === 'function'
    ? new TextEncoder().encode(value).byteLength
    : value.length;
}

function decodeBase64Url(value: string): string | undefined {
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    if (typeof atob === 'function') {
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return typeof TextDecoder === 'function'
        ? new TextDecoder().decode(bytes)
        : String.fromCharCode(...bytes);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function decodeJwtRole(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const decoded = decodeBase64Url(payload);
    if (!decoded) return undefined;
    const claims = JSON.parse(decoded) as { role?: unknown };
    return typeof claims.role === 'string' ? claims.role : undefined;
  } catch {
    return undefined;
  }
}

function assertClientCredential(value: string, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(`SupabaseRealtimeBatchTransport requires ${label}`);
  if (normalized.startsWith('sb_secret_') || /service[_-]?role/iu.test(normalized)) {
    throw new TypeError(`Secret/service-role Supabase credentials must never be used as ${label}`);
  }
  if (decodeJwtRole(normalized) === 'service_role') {
    throw new TypeError(`A service-role JWT must never be used as ${label}`);
  }
  return normalized;
}

async function resolveToken(
  value: SupabaseRealtimeBatchOptions['accessToken'],
): Promise<string | undefined> {
  const candidate = typeof value === 'function' ? await value() : value;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string') {
    throw new TypeError('Supabase accessToken callback must return a string or undefined');
  }
  return candidate.trim() || undefined;
}

function assertTopic(value: string): string {
  const topic = value.trim().replace(/^realtime:/u, '');
  if (!topic || topic.length > 180 || /[\u0000-\u001f\u007f]/u.test(topic)) {
    throw new TypeError('Supabase Realtime channel must be 1-180 printable characters');
  }
  return topic;
}

function realtimeUrl(value: string, publishableKey: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`Supabase Realtime URL must be valid, got: ${value}`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('Supabase Realtime URL must not contain embedded credentials');
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  } else if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new TypeError(`Supabase Realtime URL must use https/http/wss/ws, got ${parsed.protocol}`);
  }
  if (parsed.protocol === 'ws:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new TypeError('Supabase Realtime requires WSS outside loopback development');
  }
  if (!parsed.pathname.includes('/realtime/v1/websocket') &&
      !parsed.pathname.includes('/socket/websocket')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') + '/realtime/v1/websocket';
  }
  parsed.searchParams.set('apikey', publishableKey);
  parsed.searchParams.set('vsn', '1.0.0');
  parsed.hash = '';
  return parsed.toString();
}

function deterministicBatchId(records: readonly QueuedRecord[]): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const item of records) {
    for (let index = 0; index < item.encoded.length; index += 1) {
      const code = item.encoded.charCodeAt(index);
      left ^= code;
      left = Math.imul(left, 0x01000193) >>> 0;
      right ^= code + index;
      right = Math.imul(right, 0x85ebca6b) >>> 0;
    }
  }
  return `nl-rt-${records.length}-${left.toString(16).padStart(8, '0')}${right
    .toString(16)
    .padStart(8, '0')}`;
}

function timerUnref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (timer as typeof timer & { unref?: () => void }).unref?.();
}

/**
 * Authenticated Supabase Realtime Broadcast transport with batching, server
 * acknowledgements, reconnect/backoff, deterministic batch IDs and an optional
 * durable HTTP fallback. The persistence gateway must de-duplicate by batchId
 * and record.id because an acknowledgement can be lost after server receipt.
 */
export class SupabaseRealtimeBatchTransport implements LogTransport {
  readonly name = 'supabase-realtime-batch';
  readonly options: Readonly<SupabaseRealtimeBatchOptions>;
  readonly endpoint: string;
  readonly topic: string;

  private readonly queue = new CursorQueue<QueuedRecord>();
  private readonly resolved: ResolvedOptions;
  private readonly publishableKey: string;
  private readonly pendingReplies = new Map<string, PendingReply>();
  private socket: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private joinRef = '';
  private joined = false;
  private accepting = true;
  private closed = false;
  private ref = 0;
  private dropped = 0;
  private failures = 0;
  private reconnectAttempts = 0;
  private lastAccessToken: string | undefined;

  constructor(options: SupabaseRealtimeBatchOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('SupabaseRealtimeBatchTransport requires options');
    }
    this.publishableKey = assertClientCredential(options.publishableKey, 'a publishable key');
    const channel = assertTopic(options.channel);
    this.options = options;
    this.endpoint = realtimeUrl(options.url, this.publishableKey);
    this.topic = `realtime:${channel}`;
    const maxBatchBytes = Math.max(
      1_024,
      positiveInteger(options.maxBatchBytes, DEFAULTS.maxBatchBytes),
    );
    this.resolved = {
      batchSize: positiveInteger(options.batchSize, DEFAULTS.batchSize),
      maxQueueSize: positiveInteger(options.maxQueueSize, DEFAULTS.maxQueueSize),
      maxRecordBytes: Math.min(
        positiveInteger(options.maxRecordBytes, DEFAULTS.maxRecordBytes),
        Math.max(1, maxBatchBytes - BATCH_ENVELOPE_BYTES),
      ),
      maxBatchBytes,
      flushIntervalMillis: Math.max(
        10,
        positiveInteger(options.flushIntervalMillis, DEFAULTS.flushIntervalMillis),
      ),
      connectTimeoutMillis: Math.max(
        100,
        positiveInteger(options.connectTimeoutMillis, DEFAULTS.connectTimeoutMillis),
      ),
      ackTimeoutMillis: Math.max(
        100,
        positiveInteger(options.ackTimeoutMillis, DEFAULTS.ackTimeoutMillis),
      ),
      heartbeatMillis: Math.max(
        1_000,
        positiveInteger(options.heartbeatMillis, DEFAULTS.heartbeatMillis),
      ),
      retryBaseMillis: Math.max(
        10,
        positiveInteger(options.retryBaseMillis, DEFAULTS.retryBaseMillis),
      ),
      retryMaxMillis: Math.max(
        positiveInteger(options.retryBaseMillis, DEFAULTS.retryBaseMillis),
        positiveInteger(options.retryMaxMillis, DEFAULTS.retryMaxMillis),
      ),
      fallbackAfterFailures: nonNegativeInteger(
        options.fallbackAfterFailures,
        DEFAULTS.fallbackAfterFailures,
      ),
    };
  }

  snapshot(): SupabaseRealtimeBatchSnapshot {
    return {
      queued: this.queue.length,
      dropped: this.dropped,
      failures: this.failures,
      reconnectAttempts: this.reconnectAttempts,
      accepting: this.accepting,
      connected: this.socket?.readyState === 1,
      joined: this.joined,
      closed: this.closed,
    };
  }

  async write(record: LogRecord): Promise<void> {
    if (!this.enqueue(record)) return;
    if (this.queue.length >= this.resolved.batchSize || this.options.awaitDelivery === true) {
      const delivery = this.flush();
      if (this.options.awaitDelivery === true) await delivery;
      else void delivery.catch(() => undefined);
    } else {
      this.scheduleInterval();
    }
  }

  flush(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.clearIntervalTimer();
    let failed = false;
    this.drainPromise = this.drain()
      .catch((error) => {
        failed = true;
        this.reportError(error);
        if (this.accepting) this.scheduleRetry();
        throw error;
      })
      .finally(() => {
        this.drainPromise = null;
        if (!failed && this.queue.length > 0 && this.accepting) this.scheduleInterval();
      });
    return this.drainPromise;
  }

  async flushOnExit(records: readonly LogRecord[] = []): Promise<void> {
    for (const record of records) this.enqueue(record);
    const fallback = this.options.fallback;
    if (fallback) {
      await this.drainToFallback(fallback);
      await fallback.flushOnExit?.([]);
      return;
    }
    await this.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.accepting = false;
    this.clearTimers();
    try {
      if (this.queue.length > 0) {
        const fallback = this.options.fallback;
        if (fallback) await this.drainToFallback(fallback);
        else await this.flush();
      }
      if (this.socket?.readyState === 1 && this.joined) {
        const ref = this.nextRef();
        try {
          await this.sendWithReply({
            topic: this.topic,
            event: 'phx_leave',
            payload: {},
            ref,
            join_ref: this.joinRef,
          });
        } catch {
          // The queue is already drained; leave acknowledgement is best effort.
        }
      }
      await this.options.fallback?.flush?.();
      await this.options.fallback?.close?.();
      this.closed = true;
    } finally {
      this.disconnect(new Error('Supabase Realtime transport closed'));
    }
  }

  private enqueue(record: LogRecord): boolean {
    if (!this.accepting) {
      this.drop(record, 'closed');
      return false;
    }
    const encoded = JSON.stringify(record);
    const bytes = byteLength(encoded);
    if (bytes > this.resolved.maxRecordBytes) {
      this.drop(record, 'record-too-large');
      return false;
    }
    if (this.queue.length >= this.resolved.maxQueueSize) {
      const oldest = this.queue.shift();
      if (oldest) this.drop(oldest.record, 'queue-full');
    }
    this.queue.push({ record, encoded, bytes });
    return true;
  }

  private drop(record: LogRecord, reason: SupabaseRealtimeBatchDrop['reason']): void {
    this.dropped += 1;
    try {
      this.options.onDrop?.({ reason, record, droppedTotal: this.dropped });
    } catch {
      // Diagnostics must not recursively fail logging.
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error, this.snapshot());
    } catch {
      // Diagnostics must not recursively fail logging.
    }
  }

  private takeBatch(): QueuedRecord[] {
    const batch: QueuedRecord[] = [];
    let bytes = BATCH_ENVELOPE_BYTES;
    while (batch.length < this.resolved.batchSize && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      const nextBytes = item.bytes + 1;
      if (batch.length > 0 && bytes + nextBytes > this.resolved.maxBatchBytes) {
        this.queue.prepend([item]);
        break;
      }
      batch.push(item);
      bytes += nextBytes;
    }
    return batch;
  }

  private restoreBatch(batch: readonly QueuedRecord[]): void {
    this.queue.prepend(batch);
    while (this.queue.length > this.resolved.maxQueueSize) {
      const displaced = this.queue.pop();
      if (!displaced) break;
      this.drop(displaced.record, 'queue-full');
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.takeBatch();
      if (batch.length === 0) return;
      const usingFallback = this.shouldUseFallback();
      try {
        if (usingFallback) {
          const fallback = this.options.fallback;
          if (!fallback) throw new Error('Supabase Realtime fallback is unavailable');
          await this.sendBatchToFallback(batch, fallback);
        } else {
          await this.sendBatch(batch);
        }
        this.failures = 0;
        this.reconnectAttempts = 0;
      } catch (error) {
        this.failures += 1;
        this.restoreBatch(batch);
        // A primary WebSocket failure may cross the configured threshold and
        // retry this batch once through the durable fallback. A fallback
        // failure must escape to the caller; otherwise the same batch spins in
        // an unbounded retry loop while the HTTP collector is unavailable.
        if (!usingFallback && this.shouldUseFallback() && this.options.fallback) continue;
        throw error;
      }
    }
  }

  private shouldUseFallback(): boolean {
    return Boolean(
      this.options.fallback &&
        this.failures >= this.resolved.fallbackAfterFailures,
    );
  }

  private async sendBatchToFallback(
    batch: readonly QueuedRecord[],
    fallback: LogTransport,
  ): Promise<void> {
    for (const item of batch) await fallback.write(item.record);
    await fallback.flush?.();
  }

  private async drainToFallback(fallback: LogTransport): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.takeBatch();
      if (batch.length === 0) return;
      try {
        await this.sendBatchToFallback(batch, fallback);
      } catch (error) {
        this.restoreBatch(batch);
        throw error;
      }
    }
  }

  private async sendBatch(batch: readonly QueuedRecord[]): Promise<void> {
    await this.connect();
    await this.refreshAccessTokenIfNeeded();
    const batchId = deterministicBatchId(batch);
    const records = batch.map((item) => JSON.parse(item.encoded) as LogRecord);
    const ref = this.nextRef();
    await this.sendWithReply({
      topic: this.topic,
      event: 'broadcast',
      payload: {
        type: 'broadcast',
        event: this.options.event?.trim() || 'next-loggers-batch',
        payload: {
          schema: BATCH_SCHEMA,
          batchId,
          sentAt: this.now().toISOString(),
          records,
        },
      },
      ref,
      join_ref: this.joinRef,
    });
  }

  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Supabase Realtime transport is closed'));
    if (this.socket?.readyState === 1 && this.joined) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const socket = this.createSocket();
    this.socket = socket;
    this.joined = false;
    this.joinRef = '';
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error('Supabase Realtime connection timed out'));
      }, this.resolved.connectTimeoutMillis);
      timerUnref(timeout);

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.connectPromise = null;
        if (error) reject(error);
        else resolve();
      };

      socket.onopen = () => {
        void this.joinChannel()
          .then(() => {
            this.joined = true;
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            finish();
          })
          .catch((error: unknown) => finish(asError(error)));
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => finish(new Error('Supabase Realtime WebSocket error'));
      socket.onclose = () => {
        const error = new Error('Supabase Realtime WebSocket closed');
        this.rejectPending(error);
        this.joined = false;
        this.joinRef = '';
        this.stopHeartbeat();
        if (!settled) finish(error);
        if (this.accepting && this.queue.length > 0) this.scheduleRetry();
      };
    });
    return this.connectPromise;
  }

  private createSocket(): WebSocketLike {
    const factory = this.options.webSocketFactory ?? ((url: string) => {
      const Constructor = (globalThis as {
        WebSocket?: new (url: string) => WebSocketLike;
      }).WebSocket;
      if (!Constructor) {
        throw new Error('No WebSocket implementation is available; pass webSocketFactory');
      }
      return new Constructor(url);
    });
    return factory(this.endpoint);
  }

  private async joinChannel(): Promise<void> {
    const token = assertClientToken(
      await resolveToken(this.options.accessToken),
      this.options.allowUnauthenticated === true,
    );
    this.lastAccessToken = token;
    const ref = this.nextRef();
    this.joinRef = ref;
    await this.sendWithReply({
      topic: this.topic,
      event: 'phx_join',
      payload: {
        config: {
          broadcast: { ack: true, self: false },
          presence: { enabled: false },
          postgres_changes: [],
          private: this.options.privateChannel !== false,
        },
        ...(token ? { access_token: token } : {}),
      },
      ref,
      join_ref: ref,
    }, false);
  }

  private async refreshAccessTokenIfNeeded(): Promise<void> {
    const token = assertClientToken(
      await resolveToken(this.options.accessToken),
      this.options.allowUnauthenticated === true,
    );
    if (!token || token === this.lastAccessToken) return;
    const ref = this.nextRef();
    await this.sendWithReply({
      topic: this.topic,
      event: 'access_token',
      payload: { access_token: token },
      ref,
      join_ref: this.joinRef,
    });
    this.lastAccessToken = token;
  }

  private sendWithReply(message: PhoenixMessage, requireJoined = true): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || (requireJoined && !this.joined)) {
      return Promise.reject(new Error('Supabase Realtime channel is not connected'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(message.ref);
        reject(new Error(`Supabase Realtime acknowledgement timed out for ref ${message.ref}`));
      }, this.resolved.ackTimeoutMillis);
      timerUnref(timer);
      this.pendingReplies.set(message.ref, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pendingReplies.delete(message.ref);
        reject(asError(error));
      }
    });
  }

  private handleMessage(data: unknown): void {
    let message: {
      topic?: unknown;
      event?: unknown;
      ref?: unknown;
      payload?: { status?: unknown; response?: unknown };
    };
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      return;
    }
    if (message.event === 'phx_error' || message.event === 'phx_close') {
      this.socket?.close(1011, `Supabase Realtime sent ${String(message.event)}`);
      return;
    }
    if (message.event !== 'phx_reply' || typeof message.ref !== 'string') return;
    const pending = this.pendingReplies.get(message.ref);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingReplies.delete(message.ref);
    if (message.payload?.status === 'ok') pending.resolve();
    else pending.reject(new Error(`Supabase Realtime rejected ref ${message.ref}`));
  }

  private rejectPending(error: Error): void {
    for (const [ref, pending] of this.pendingReplies) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingReplies.delete(ref);
    }
  }

  private disconnect(error: Error): void {
    this.rejectPending(error);
    this.stopHeartbeat();
    this.socket?.close(1000, 'next-loggers transport closed');
    this.socket = null;
    this.joined = false;
    this.joinRef = '';
    this.connectPromise = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState !== 1) return;
      const ref = this.nextRef();
      void this.sendWithReply({
        topic: 'phoenix',
        event: 'heartbeat',
        payload: {},
        ref,
      }, false).catch(() => this.socket?.close(1011, 'heartbeat acknowledgement failed'));
    }, this.resolved.heartbeatMillis);
    timerUnref(this.heartbeatTimer);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleInterval(): void {
    if (!this.accepting || this.intervalTimer || this.retryTimer || this.queue.length === 0) return;
    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = null;
      void this.flush().catch(() => undefined);
    }, this.resolved.flushIntervalMillis);
    timerUnref(this.intervalTimer);
  }

  private scheduleRetry(): void {
    if (!this.accepting || this.retryTimer || this.queue.length === 0) return;
    this.clearIntervalTimer();
    const exponential = Math.min(
      this.resolved.retryMaxMillis,
      this.resolved.retryBaseMillis * 2 ** Math.min(this.reconnectAttempts, 20),
    );
    const delay = exponential * (0.8 + this.randomUnit() * 0.4);
    this.reconnectAttempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.disconnect(new Error('Supabase Realtime reconnecting'));
      void this.flush().catch(() => undefined);
    }, delay);
    timerUnref(this.retryTimer);
  }

  private clearIntervalTimer(): void {
    if (this.intervalTimer) clearTimeout(this.intervalTimer);
    this.intervalTimer = null;
  }

  private clearTimers(): void {
    this.clearIntervalTimer();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopHeartbeat();
  }

  private nextRef(): string {
    this.ref += 1;
    return String(this.ref);
  }

  private randomUnit(): number {
    try {
      const value = this.options.random?.() ?? Math.random();
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
    } catch {
      return 0.5;
    }
  }

  private now(): Date {
    try {
      const value = this.options.clock?.() ?? new Date();
      return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
    } catch {
      return new Date();
    }
  }
}

function assertClientToken(token: string | undefined, allowUnauthenticated: boolean): string | undefined {
  if (!token) {
    if (!allowUnauthenticated) {
      throw new Error(
        'Supabase Realtime telemetry requires a user access token; ' +
          'set allowUnauthenticated only for a deliberately public gateway',
      );
    }
    return undefined;
  }
  return assertClientCredential(token, 'a user access token');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createSupabaseRealtimeBatchTransport(
  options: SupabaseRealtimeBatchOptions,
): SupabaseRealtimeBatchTransport {
  return new SupabaseRealtimeBatchTransport(options);
}
