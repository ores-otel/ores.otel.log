import type { LogRecord, LogTransport, WebSocketLike } from './base-logger.js';
import {
  assertClientCredential,
  createWaiter,
  numberOption,
  realtimeUrl,
  unref,
  type IdleWaiter,
  type InFlight,
  type Pending,
  type Reply,
  type SupabaseRealtimeAckOptions,
  type SupabaseRealtimeDropReason,
  type SupabaseRealtimeSnapshot,
} from './supabase-realtime-common.js';

export * from './supabase-realtime-common.js';

/**
 * Private Supabase Broadcast transport that waits for the exact Phoenix reply.
 * An acknowledgement proves Realtime receipt, not a durable Postgres commit.
 */
export class SupabaseRealtimeAckTransport implements LogTransport {
  readonly name = 'supabase-realtime-ack';
  readonly options: Readonly<SupabaseRealtimeAckOptions>;

  private queue: Pending[] = [];
  private readonly inFlight = new Map<string, InFlight>();
  private readonly idleWaiters = new Set<IdleWaiter>();
  private socket: WebSocketLike | null = null;
  private connectTask: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatAckTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatRef = '';
  private joinRef = '';
  private ref = 0;
  private joined = false;
  private accepting = true;
  private closed = false;
  private closeTask: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private acknowledged = 0;
  private failures = 0;
  private dropped = 0;

  constructor(options: SupabaseRealtimeAckOptions) {
    assertClientCredential(options.publishableKey, 'publishableKey');
    realtimeUrl(options.url);
    this.options = options;
  }

  snapshot(): SupabaseRealtimeSnapshot {
    return {
      queued: this.queue.length,
      inFlight: this.inFlight.size,
      acknowledged: this.acknowledged,
      failures: this.failures,
      dropped: this.dropped,
      reconnectAttempts: this.reconnectAttempts,
      connected: this.socket?.readyState === 1,
      joined: this.joined,
      accepting: this.accepting,
      closed: this.closed,
    };
  }

  private get topic(): string {
    const value = (this.options.channel ?? 'next-loggers').trim() || 'next-loggers';
    return `realtime:${value.replace(/^realtime:/, '')}`;
  }

  private nextRef(): string {
    this.ref += 1;
    return String(this.ref);
  }

  private hasAwaiter(): boolean {
    return (
      this.queue.some((item) => item.waiter) ||
      [...this.inFlight.values()].some((item) => item.pending.waiter)
    );
  }

  private error(error: unknown): void {
    try {
      this.options.onError?.(error, this.snapshot());
    } catch {
      // Diagnostics cannot recursively destabilize delivery.
    }
  }

  private drop(item: Pending, reason: SupabaseRealtimeDropReason, error?: unknown): void {
    this.dropped += 1;
    item.waiter?.reject(
      error ?? new Error(`Supabase Realtime dropped ${item.record.id}: ${reason}`),
    );
    try {
      this.options.onDrop?.({ reason, record: item.record, droppedTotal: this.dropped });
    } catch {
      // Observer failures are isolated.
    }
  }

  private notifyIdle(): void {
    if (this.queue.length || this.inFlight.size) return;
    for (const item of this.idleWaiters) {
      if (item.timer) clearTimeout(item.timer);
      item.resolve();
    }
    this.idleWaiters.clear();
  }

  private waitForIdle(): Promise<void> {
    if (!this.queue.length && !this.inFlight.size) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const item: IdleWaiter = { resolve, reject };
      const timeout = numberOption(this.options.flushTimeoutMillis, 15_000, 0);
      if (timeout > 0) {
        item.timer = setTimeout(() => {
          this.idleWaiters.delete(item);
          reject(
            new Error(
              `Supabase Realtime flush timed out with ${this.queue.length} queued and ` +
                `${this.inFlight.size} in flight`,
            ),
          );
        }, timeout);
      }
      this.idleWaiters.add(item);
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatAckTimer) clearTimeout(this.heartbeatAckTimer);
    this.heartbeatTimer = null;
    this.heartbeatAckTimer = null;
    this.heartbeatRef = '';
  }

  private heartbeat(): void {
    if (!this.socket || this.socket.readyState !== 1 || !this.joined || this.heartbeatRef) {
      return;
    }
    const ref = this.nextRef();
    this.heartbeatRef = ref;
    try {
      this.socket.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref }));
    } catch (error) {
      this.failures += 1;
      this.error(error);
      this.closeSocket(1011, 'heartbeat send failed');
      return;
    }
    this.heartbeatAckTimer = setTimeout(() => {
      this.heartbeatAckTimer = null;
      this.heartbeatRef = '';
      this.failures += 1;
      this.error(new Error('Supabase Realtime heartbeat acknowledgement timed out'));
      this.closeSocket(1011, 'heartbeat timed out');
    }, numberOption(this.options.heartbeatTimeoutMillis, 10_000));
    unref(this.heartbeatAckTimer);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = numberOption(this.options.heartbeatMillis, 25_000, 0);
    if (!interval) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), interval);
    unref(this.heartbeatTimer);
  }

  private closeSocket(code: number, reason: string): void {
    try {
      this.socket?.close(code, reason.slice(0, 120));
    } catch {
      // onclose or a later retry repairs state.
    }
  }

  private restoreInFlight(error: unknown): void {
    const restored: Pending[] = [];
    const maxAttempts = numberOption(this.options.maxAttempts, 3);
    for (const { pending, timer } of this.inFlight.values()) {
      clearTimeout(timer);
      if (pending.attempts >= maxAttempts) this.drop(pending, 'delivery-failed', error);
      else restored.push(pending);
    }
    this.inFlight.clear();
    this.queue = [...restored, ...this.queue];
    this.notifyIdle();
  }

  private failPending(error: unknown): void {
    this.restoreInFlight(error);
    for (const item of this.queue) this.drop(item, 'delivery-failed', error);
    this.queue = [];
    this.notifyIdle();
  }

  private randomUnit(): number {
    try {
      const value = this.options.random?.() ?? Math.random();
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
    } catch {
      return 0.5;
    }
  }

  private scheduleReconnect(): void {
    if (
      this.closed ||
      this.options.reconnect === false ||
      this.reconnectTimer ||
      (!this.queue.length && !this.inFlight.size)
    ) {
      return;
    }
    const maximum = numberOption(this.options.maxReconnectAttempts, 10);
    if (this.reconnectAttempts >= maximum) {
      const error = new Error(`Supabase Realtime exhausted ${maximum} reconnect attempts`);
      this.error(error);
      this.failPending(error);
      return;
    }
    const base = numberOption(this.options.retryBaseMillis, 500);
    const cap = numberOption(this.options.retryMaxMillis, 30_000);
    const ceiling = Math.min(cap, base * 2 ** Math.min(this.reconnectAttempts, 20));
    const delay = Math.max(1, Math.floor(ceiling * (0.5 + this.randomUnit() * 0.5)));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.kick();
    }, delay);
    if (!this.hasAwaiter()) unref(this.reconnectTimer);
  }

  private socketFactory(): WebSocketLike {
    const factory =
      this.options.webSocketFactory ??
      ((url: string): WebSocketLike => {
        const Constructor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike })
          .WebSocket;
        if (!Constructor) throw new Error('No WebSocket available; pass webSocketFactory');
        return new Constructor(url);
      });
    const url = new URL(realtimeUrl(this.options.url));
    url.searchParams.set('apikey', this.options.publishableKey);
    url.searchParams.set('vsn', '1.0.0');
    return factory(url.toString());
  }

  private async token(): Promise<string | undefined> {
    const value =
      typeof this.options.accessToken === 'function'
        ? await this.options.accessToken()
        : this.options.accessToken;
    const normalized = value?.trim() || undefined;
    if (normalized) assertClientCredential(normalized, 'accessToken');
    if (!normalized && this.options.allowUnauthenticated !== true) {
      throw new Error('Supabase Realtime requires a user access token');
    }
    return normalized;
  }

  private async open(): Promise<void> {
    const accessToken = await this.token();
    const socket = this.socketFactory();
    this.socket = socket;
    this.joined = false;
    this.joinRef = '';

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(
        () => finish(new Error('Supabase Realtime channel join timed out')),
        numberOption(this.options.connectTimeoutMillis, 8_000),
      );
      if (!this.hasAwaiter()) unref(timeout);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };

      socket.onopen = () => {
        const ref = this.nextRef();
        this.joinRef = ref;
        try {
          socket.send(
            JSON.stringify({
              topic: this.topic,
              event: 'phx_join',
              payload: {
                config: {
                  broadcast: { ack: true, self: false },
                  presence: { enabled: false },
                  postgres_changes: [],
                  private: this.options.privateChannel !== false,
                },
                access_token: accessToken ?? this.options.publishableKey,
              },
              ref,
              join_ref: ref,
            }),
          );
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };

      socket.onmessage = (event) => {
        let message: Reply;
        try {
          message = JSON.parse(String(event.data)) as Reply;
        } catch {
          return;
        }
        if (
          message.topic === this.topic &&
          message.event === 'phx_reply' &&
          message.ref === this.joinRef
        ) {
          if (message.payload?.status === 'ok') {
            this.joined = true;
            this.reconnectAttempts = 0;
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            this.startHeartbeat();
            finish();
            this.pump();
          } else {
            finish(new Error('Supabase Realtime rejected the channel join'));
            this.closeSocket(1008, 'channel join rejected');
          }
          return;
        }
        this.onMessage(message);
      };

      socket.onerror = () => {
        const error = new Error('Supabase Realtime WebSocket error');
        if (!this.joined) finish(error);
        this.failures += 1;
        this.error(error);
        this.closeSocket(1011, error.message);
      };

      socket.onclose = () => {
        const current = this.socket === socket;
        const error = new Error('Supabase Realtime closed before acknowledgement');
        if (current) {
          this.socket = null;
          this.joined = false;
          this.joinRef = '';
          this.stopHeartbeat();
          this.restoreInFlight(error);
        }
        if (!settled) finish(new Error('Supabase Realtime closed before joining'));
        if (current) {
          if (this.options.reconnect === false) this.failPending(error);
          else this.scheduleReconnect();
        }
      };
    });
  }

  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Supabase Realtime is closed'));
    if (this.socket?.readyState === 1 && this.joined) return Promise.resolve();
    if (this.connectTask) return this.connectTask;
    const task = this.open();
    this.connectTask = task;
    void task.finally(() => {
      if (this.connectTask === task) this.connectTask = null;
    }).catch(() => undefined);
    return task;
  }

  private onMessage(message: Reply): void {
    const ref = message.ref;
    if (
      message.topic === 'phoenix' &&
      message.event === 'phx_reply' &&
      ref === this.heartbeatRef
    ) {
      if (this.heartbeatAckTimer) clearTimeout(this.heartbeatAckTimer);
      this.heartbeatAckTimer = null;
      this.heartbeatRef = '';
      return;
    }
    if (message.topic === this.topic && message.event === 'phx_reply' && ref) {
      const entry = this.inFlight.get(ref);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.inFlight.delete(ref);
      if (message.payload?.status === 'ok') {
        this.acknowledged += 1;
        entry.pending.waiter?.resolve();
        this.notifyIdle();
        this.pump();
      } else {
        this.retry(entry.pending, new Error('Supabase Realtime rejected a broadcast'));
      }
      return;
    }
    if (
      message.topic === this.topic &&
      (message.event === 'phx_error' || message.event === 'phx_close')
    ) {
      const error = new Error(`Supabase Realtime sent ${message.event}`);
      this.failures += 1;
      this.error(error);
      this.closeSocket(1011, error.message);
    }
  }

  private retry(item: Pending, error: unknown): void {
    this.failures += 1;
    this.error(error);
    if (item.attempts >= numberOption(this.options.maxAttempts, 3)) {
      this.drop(item, 'delivery-failed', error);
      this.notifyIdle();
      this.pump();
      return;
    }
    this.queue.unshift(item);
    this.closeSocket(1011, 'delivery retry');
    this.scheduleReconnect();
  }

  private pump(): void {
    if (!this.socket || this.socket.readyState !== 1 || !this.joined || this.closed) return;
    const maximum = numberOption(this.options.maxInFlight, 16);
    const timeout = numberOption(this.options.ackTimeoutMillis, 8_000);
    while (this.inFlight.size < maximum && this.queue.length) {
      const pending = this.queue.shift();
      if (!pending) break;
      pending.attempts += 1;
      const ref = this.nextRef();
      const timer = setTimeout(() => {
        const entry = this.inFlight.get(ref);
        if (!entry) return;
        this.inFlight.delete(ref);
        this.retry(entry.pending, new Error(`Supabase Realtime ACK timed out for ${entry.pending.record.id}`));
      }, timeout);
      if (!pending.waiter) unref(timer);
      this.inFlight.set(ref, { pending, timer });
      try {
        this.socket.send(
          JSON.stringify({
            topic: this.topic,
            event: 'broadcast',
            payload: {
              type: 'broadcast',
              event: this.options.event ?? 'log',
              payload: pending.record,
            },
            ref,
            join_ref: this.joinRef,
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.inFlight.delete(ref);
        this.retry(pending, error);
        break;
      }
    }
  }

  private kick(): void {
    if (this.closed || this.reconnectTimer || (!this.queue.length && !this.inFlight.size)) return;
    if (this.socket?.readyState === 1 && this.joined) {
      this.pump();
      return;
    }
    void this.connect()
      .then(() => this.pump())
      .catch((error) => {
        this.failures += 1;
        this.error(error);
        if (this.options.reconnect === false) this.failPending(error);
        else this.scheduleReconnect();
      });
  }

  write(record: LogRecord): Promise<void> {
    if (!this.accepting || this.closed) {
      const error = new Error('Supabase Realtime transport is closed');
      const item: Pending = { record, attempts: 0 };
      this.error(error);
      this.drop(item, 'closed', error);
      return this.options.awaitDelivery ? Promise.reject(error) : Promise.resolve();
    }
    const deliveryWaiter = this.options.awaitDelivery ? createWaiter() : undefined;
    const item: Pending = {
      record,
      attempts: 0,
      ...(deliveryWaiter ? { waiter: deliveryWaiter } : {}),
    };
    const maximum = numberOption(this.options.maxQueueSize, 2_000, 0);
    while (this.queue.length >= maximum && this.queue.length) {
      const displaced = this.queue.shift();
      if (displaced) this.drop(displaced, 'queue-full');
    }
    if (!maximum) {
      this.drop(item, 'queue-full');
      return deliveryWaiter?.promise ?? Promise.resolve();
    }
    this.queue.push(item);
    this.kick();
    return deliveryWaiter?.promise ?? Promise.resolve();
  }

  async flush(): Promise<void> {
    if (!this.queue.length && !this.inFlight.size) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const idle = this.waitForIdle();
    this.kick();
    try {
      await idle;
    } catch (error) {
      this.failures += 1;
      this.error(error);
      throw error;
    }
  }

  flushOnExit(_records?: readonly LogRecord[]): Promise<void> {
    return this.flush();
  }

  refreshAuth(): void {
    if (this.closed) return;
    this.socket ? this.closeSocket(4000, 'auth refresh') : this.kick();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closeTask) return this.closeTask;
    this.closeTask = this.performClose().finally(() => {
      this.closeTask = null;
    });
    return this.closeTask;
  }

  private async performClose(): Promise<void> {
    this.accepting = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    let failure: unknown;
    try {
      await this.flush();
    } catch (error) {
      failure = error;
    }
    this.closed = true;
    this.stopHeartbeat();
    const error = failure ?? new Error('Supabase Realtime closed before delivery');
    this.failPending(error);
    this.closeSocket(1000, 'transport closed');
    this.socket = null;
    this.joined = false;
    for (const item of this.idleWaiters) {
      if (item.timer) clearTimeout(item.timer);
      item.reject(error);
    }
    this.idleWaiters.clear();
    if (failure) throw failure;
  }
}

export const createSupabaseRealtimeAckTransport = (
  options: SupabaseRealtimeAckOptions,
): SupabaseRealtimeAckTransport => new SupabaseRealtimeAckTransport(options);
