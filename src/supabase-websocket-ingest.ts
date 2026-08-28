import type { LogRecord, LogTransport } from './base-logger.js';

export const ORES_SUPABASE_WEBSOCKET_PROTOCOL = 'ores-otel/ws-ingest/v1' as const;

export interface SupabaseWebSocketTicket {
  /** A short-lived, one-time ticket minted by the application backend. */
  ticket: string;
  /** Complete Supabase Edge Function WebSocket endpoint. Must use wss://. */
  url: string;
  expiresAtMillis?: number;
}

export interface SupabaseTelemetrySession {
  appName: string;
  runtime: string;
  sessionId: string;
  clientInstanceId: string;
  appVersion?: string;
  release?: string;
}

export interface SupabaseWebSocketRecord {
  recordId: string;
  record: LogRecord;
}

export interface SupabaseWebSocketBatch {
  type: 'telemetry_batch';
  protocol: typeof ORES_SUPABASE_WEBSOCKET_PROTOCOL;
  batchId: string;
  sequence: number;
  sentAt: string;
  session: SupabaseTelemetrySession;
  records: readonly SupabaseWebSocketRecord[];
}

export interface SupabaseWebSocketCommitAck {
  type: 'commit_ack';
  protocol: typeof ORES_SUPABASE_WEBSOCKET_PROTOCOL;
  batchId: string;
  sequence: number;
  accepted: number;
  duplicates: number;
  committedAt: string;
}

export interface SupabaseWebSocketSnapshot {
  queued: number;
  inFlight: number;
  accepted: number;
  duplicates: number;
  replayedBatches: number;
  dropped: number;
  failures: number;
  protocolErrors: number;
  reconnects: number;
  connected: boolean;
  accepting: boolean;
  closed: boolean;
  lastAcknowledgedSequence: number;
}

export interface SupabaseWebSocketDrop {
  reason: 'closed' | 'queue-full' | 'record-too-large';
  record: LogRecord;
  droppedTotal: number;
}

export interface WebSocketLike {
  readonly readyState: number;
  readonly OPEN?: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SupabaseWebSocketExitFallback {
  /** Persist the exact in-flight batch through authenticated HTTPS. */
  persist(batch: SupabaseWebSocketBatch): Promise<SupabaseWebSocketCommitAck>;
}

export interface SupabaseWebSocketIngestOptions {
  ticketProvider: () => SupabaseWebSocketTicket | Promise<SupabaseWebSocketTicket>;
  session: SupabaseTelemetrySession;
  webSocketFactory?: (url: string) => WebSocketLike;
  exitFallback?: SupabaseWebSocketExitFallback;
  allowedHosts?: readonly string[];
  batchSize?: number;
  maxQueueSize?: number;
  maxRecordBytes?: number;
  flushIntervalMillis?: number;
  acknowledgementTimeoutMillis?: number;
  reconnectBaseMillis?: number;
  reconnectMaxMillis?: number;
  maxReconnectAttempts?: number;
  awaitAcknowledgement?: boolean;
  clock?: () => Date;
  random?: () => number;
  recordIdFactory?: () => string;
  batchIdFactory?: () => string;
  onDrop?: (drop: SupabaseWebSocketDrop) => void;
  onError?: (error: unknown, snapshot: SupabaseWebSocketSnapshot) => void;
}

interface ResolvedOptions {
  batchSize: number;
  maxQueueSize: number;
  maxRecordBytes: number;
  flushIntervalMillis: number;
  acknowledgementTimeoutMillis: number;
  reconnectBaseMillis: number;
  reconnectMaxMillis: number;
  maxReconnectAttempts: number;
}

interface QueuedRecord extends SupabaseWebSocketRecord {
  bytes: number;
}

interface AckWaiter {
  batchId: string;
  sequence: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (ack: SupabaseWebSocketCommitAck) => void;
  reject: (error: Error) => void;
}

const DEFAULTS: ResolvedOptions = {
  batchSize: 50,
  maxQueueSize: 2_000,
  maxRecordBytes: 128 * 1_024,
  flushIntervalMillis: 1_000,
  acknowledgementTimeoutMillis: 10_000,
  reconnectBaseMillis: 250,
  reconnectMaxMillis: 10_000,
  maxReconnectAttempts: 8,
};

function integer(value: number | undefined, fallback: number, minimum: number): number {
  return Number.isInteger(value) && Number(value) >= minimum ? Number(value) : fallback;
}

function byteLength(value: string): number {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(value).byteLength : value.length;
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

function randomId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function assertSession(session: SupabaseTelemetrySession): void {
  for (const [key, value] of Object.entries(session)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`Supabase WebSocket session ${key} must be a non-empty string`);
    }
  }
}

function assertTicket(ticket: SupabaseWebSocketTicket, allowedHosts?: readonly string[]): URL {
  if (!ticket || typeof ticket !== 'object') throw new TypeError('ticketProvider returned no ticket');
  if (typeof ticket.ticket !== 'string' || ticket.ticket.trim().length < 16) {
    throw new TypeError('Supabase WebSocket ticket must be a non-empty short-lived credential');
  }
  if (ticket.expiresAtMillis !== undefined && ticket.expiresAtMillis <= Date.now()) {
    throw new Error('Supabase WebSocket ticket is expired');
  }
  let url: URL;
  try {
    url = new URL(ticket.url);
  } catch {
    throw new TypeError(`Supabase WebSocket URL is invalid: ${ticket.url}`);
  }
  if (url.protocol !== 'wss:') throw new TypeError('Supabase telemetry WebSocket requires wss://');
  if (url.username || url.password) throw new TypeError('Supabase WebSocket URL must not embed credentials');
  if (allowedHosts && !allowedHosts.includes(url.hostname)) {
    throw new TypeError(`Supabase WebSocket host ${url.hostname} is not in allowedHosts`);
  }
  return url;
}

function parseMessage(data: unknown): unknown {
  if (typeof data === 'string') return JSON.parse(data) as unknown;
  if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data)) as unknown;
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(new TextDecoder().decode(data as ArrayBufferView<ArrayBuffer>)) as unknown;
  }
  throw new TypeError('Supabase WebSocket message must be UTF-8 JSON');
}

function isCommitAck(value: unknown): value is SupabaseWebSocketCommitAck {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.type === 'commit_ack'
    && record.protocol === ORES_SUPABASE_WEBSOCKET_PROTOCOL
    && typeof record.batchId === 'string'
    && Number.isInteger(record.sequence)
    && Number.isInteger(record.accepted)
    && Number.isInteger(record.duplicates)
    && typeof record.committedAt === 'string';
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  if (typeof WebSocket !== 'function') {
    throw new Error('WebSocket is unavailable; provide webSocketFactory for this runtime');
  }
  return new WebSocket(url) as unknown as WebSocketLike;
}

/**
 * Durable session telemetry transport for Supabase Edge Functions.
 *
 * Records leave memory only after a matching post-transaction `commit_ack`.
 * A disconnect before that ACK preserves the exact batch ID, sequence, and
 * records so the server can idempotently replay it. Supabase Realtime
 * Broadcast acknowledgements are deliberately not accepted as durability.
 */
export class SupabaseWebSocketIngestTransport implements LogTransport {
  readonly name = 'supabase-websocket-ingest';
  readonly options: Readonly<SupabaseWebSocketIngestOptions>;

  private readonly resolved: ResolvedOptions;
  private readonly queue: QueuedRecord[] = [];
  private socket: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private flushPromise: Promise<void> | null = null;
  private inFlight: SupabaseWebSocketBatch | null = null;
  private ackWaiter: AckWaiter | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private nextSequence = 1;
  private accepted = 0;
  private duplicates = 0;
  private replayedBatches = 0;
  private dropped = 0;
  private failures = 0;
  private protocolErrors = 0;
  private reconnects = 0;
  private lastAcknowledgedSequence = 0;
  private accepting = true;
  private closed = false;

  constructor(options: SupabaseWebSocketIngestOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('options are required');
    if (typeof options.ticketProvider !== 'function') throw new TypeError('ticketProvider is required');
    assertSession(options.session);
    this.options = options;
    const reconnectBaseMillis = integer(options.reconnectBaseMillis, DEFAULTS.reconnectBaseMillis, 0);
    this.resolved = {
      batchSize: integer(options.batchSize, DEFAULTS.batchSize, 1),
      maxQueueSize: integer(options.maxQueueSize, DEFAULTS.maxQueueSize, 1),
      maxRecordBytes: integer(options.maxRecordBytes, DEFAULTS.maxRecordBytes, 1),
      flushIntervalMillis: integer(options.flushIntervalMillis, DEFAULTS.flushIntervalMillis, 1),
      acknowledgementTimeoutMillis: integer(
        options.acknowledgementTimeoutMillis,
        DEFAULTS.acknowledgementTimeoutMillis,
        1,
      ),
      reconnectBaseMillis,
      reconnectMaxMillis: Math.max(
        reconnectBaseMillis,
        integer(options.reconnectMaxMillis, DEFAULTS.reconnectMaxMillis, 0),
      ),
      maxReconnectAttempts: integer(options.maxReconnectAttempts, DEFAULTS.maxReconnectAttempts, 0),
    };
  }

  snapshot(): SupabaseWebSocketSnapshot {
    return {
      queued: this.queue.length,
      inFlight: this.inFlight?.records.length ?? 0,
      accepted: this.accepted,
      duplicates: this.duplicates,
      replayedBatches: this.replayedBatches,
      dropped: this.dropped,
      failures: this.failures,
      protocolErrors: this.protocolErrors,
      reconnects: this.reconnects,
      connected: this.isOpen(),
      accepting: this.accepting,
      closed: this.closed,
      lastAcknowledgedSequence: this.lastAcknowledgedSequence,
    };
  }

  async write(record: LogRecord): Promise<void> {
    if (!this.enqueue(record)) return;
    if (this.options.awaitAcknowledgement === true || this.queue.length >= this.resolved.batchSize) {
      const delivery = this.flush();
      if (this.options.awaitAcknowledgement === true) await delivery;
      else void delivery.catch((error: unknown) => this.reportError(error));
    } else {
      this.scheduleFlush();
    }
  }

  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.clearFlushTimer();
    const task = this.drainWithReconnect().finally(() => {
      if (this.flushPromise === task) this.flushPromise = null;
      if (this.accepting && this.queue.length > 0) this.scheduleFlush();
    });
    this.flushPromise = task;
    return task;
  }

  async flushOnExit(records: readonly LogRecord[] = []): Promise<void> {
    for (const record of records) this.enqueue(record);
    const fallback = this.options.exitFallback;
    if (!fallback) {
      await this.flush();
      return;
    }
    this.clearFlushTimer();
    while (this.inFlight || this.queue.length > 0) {
      const batch = this.inFlight ?? this.createBatch();
      if (!batch) break;
      this.inFlight = batch;
      const ack = await fallback.persist(batch);
      this.commit(batch, ack);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.accepting = false;
    this.clearFlushTimer();
    try {
      await this.flushOnExit();
    } finally {
      this.closed = true;
      this.rejectAck(new Error('Supabase WebSocket transport closed'));
      const socket = this.socket;
      this.socket = null;
      if (socket && socket.readyState !== 3) socket.close(1000, 'transport closed');
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
      const displaced = this.queue.shift();
      if (displaced) this.drop(displaced.record, 'queue-full');
    }
    this.queue.push({
      recordId: this.options.recordIdFactory?.() ?? randomId('record'),
      record,
      bytes,
    });
    return true;
  }

  private createBatch(): SupabaseWebSocketBatch | null {
    if (this.queue.length === 0) return null;
    const queued = this.queue.splice(0, this.resolved.batchSize);
    const records = queued.map(({ recordId, record }) => ({ recordId, record }));
    return {
      type: 'telemetry_batch',
      protocol: ORES_SUPABASE_WEBSOCKET_PROTOCOL,
      batchId: this.options.batchIdFactory?.() ?? randomId('batch'),
      sequence: this.nextSequence,
      sentAt: (this.options.clock?.() ?? new Date()).toISOString(),
      session: this.options.session,
      records,
    };
  }

  private async drainWithReconnect(): Promise<void> {
    let attempts = 0;
    while (this.inFlight || this.queue.length > 0) {
      const batch = this.inFlight ?? this.createBatch();
      if (!batch) return;
      const replay = this.inFlight !== null;
      this.inFlight = batch;
      if (replay) this.replayedBatches += 1;
      try {
        await this.connect();
        const ack = await this.sendAndWait(batch);
        this.commit(batch, ack);
        attempts = 0;
      } catch (error) {
        this.failures += 1;
        this.reportError(error);
        this.disconnect(1012, 'retrying unacknowledged batch');
        if (attempts >= this.resolved.maxReconnectAttempts) throw error;
        attempts += 1;
        this.reconnects += 1;
        await this.delayFor(attempts);
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.isOpen()) return;
    if (this.connectPromise) return this.connectPromise;
    const task = this.openConnection().finally(() => {
      if (this.connectPromise === task) this.connectPromise = null;
    });
    this.connectPromise = task;
    return task;
  }

  private async openConnection(): Promise<void> {
    const ticket = await this.options.ticketProvider();
    const url = assertTicket(ticket, this.options.allowedHosts);
    const factory = this.options.webSocketFactory ?? defaultWebSocketFactory;
    const socket = factory(url.toString());
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) {
          socket.close(1008, 'connect timeout');
          reject(new Error('Supabase WebSocket connection timed out'));
        }
      }, this.resolved.acknowledgementTimeoutMillis);

      socket.onopen = () => {
        opened = true;
        clearTimeout(timer);
        try {
          socket.send(JSON.stringify({
            type: 'hello',
            protocol: ORES_SUPABASE_WEBSOCKET_PROTOCOL,
            ticket: ticket.ticket,
            session: this.options.session,
          }));
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => {
        if (!opened) reject(new Error('Supabase WebSocket connection failed'));
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        const reason = event.reason ? `: ${event.reason}` : '';
        const error = new Error(`Supabase WebSocket closed before commit ACK${reason}`);
        this.rejectAck(error);
        if (!opened) reject(error);
      };
    });
  }

  private sendAndWait(batch: SupabaseWebSocketBatch): Promise<SupabaseWebSocketCommitAck> {
    const socket = this.socket;
    if (!socket || !this.isOpen()) throw new Error('Supabase WebSocket is not open');
    if (this.ackWaiter) throw new Error('only one Supabase telemetry batch may be in flight');
    return new Promise<SupabaseWebSocketCommitAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectAck(new Error(`Supabase commit ACK timed out for ${batch.batchId}`));
      }, this.resolved.acknowledgementTimeoutMillis);
      this.ackWaiter = { batchId: batch.batchId, sequence: batch.sequence, timer, resolve, reject };
      try {
        socket.send(JSON.stringify(batch));
      } catch (error) {
        this.rejectAck(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(data: unknown): void {
    let message: unknown;
    try {
      message = parseMessage(data);
    } catch (error) {
      this.protocolFailure(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!isCommitAck(message)) return;
    const waiter = this.ackWaiter;
    if (!waiter) {
      this.protocolFailure(new Error('received a commit ACK with no in-flight batch'));
      return;
    }
    if (message.batchId !== waiter.batchId || message.sequence !== waiter.sequence) {
      this.protocolFailure(new Error('commit ACK batchId or sequence mismatch'));
      return;
    }
    clearTimeout(waiter.timer);
    this.ackWaiter = null;
    waiter.resolve(message);
  }

  private commit(batch: SupabaseWebSocketBatch, ack: SupabaseWebSocketCommitAck): void {
    if (!isCommitAck(ack)) throw new TypeError('fallback did not return a valid commit ACK');
    if (ack.batchId !== batch.batchId || ack.sequence !== batch.sequence) {
      throw new Error('commit ACK batchId or sequence mismatch');
    }
    if (ack.accepted < 0 || ack.duplicates < 0 || ack.accepted + ack.duplicates !== batch.records.length) {
      throw new Error('commit ACK does not account for the complete batch');
    }
    this.accepted += ack.accepted;
    this.duplicates += ack.duplicates;
    this.lastAcknowledgedSequence = batch.sequence;
    this.nextSequence = batch.sequence + 1;
    this.inFlight = null;
  }

  private protocolFailure(error: Error): void {
    this.protocolErrors += 1;
    this.rejectAck(error);
    this.disconnect(1002, 'invalid commit ACK');
  }

  private rejectAck(error: Error): void {
    const waiter = this.ackWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.ackWaiter = null;
    waiter.reject(error);
  }

  private disconnect(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== 3) socket.close(code, reason);
  }

  private isOpen(): boolean {
    const socket = this.socket;
    return Boolean(socket && socket.readyState === (socket.OPEN ?? 1));
  }

  private scheduleFlush(): void {
    if (this.flushTimer || !this.accepting || this.queue.length === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error: unknown) => this.reportError(error));
    }, this.resolved.flushIntervalMillis);
    unref(this.flushTimer);
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async delayFor(attempt: number): Promise<void> {
    const exponent = Math.min(20, Math.max(0, attempt - 1));
    const base = Math.min(
      this.resolved.reconnectMaxMillis,
      this.resolved.reconnectBaseMillis * 2 ** exponent,
    );
    const random = Math.min(1, Math.max(0, this.options.random?.() ?? Math.random()));
    const delay = Math.round(base * (0.5 + random * 0.5));
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  private drop(record: LogRecord, reason: SupabaseWebSocketDrop['reason']): void {
    this.dropped += 1;
    try {
      this.options.onDrop?.({ reason, record, droppedTotal: this.dropped });
    } catch {
      // Diagnostics must never create recursive logger failures.
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error, this.snapshot());
    } catch {
      // Diagnostics must never create recursive logger failures.
    }
  }
}
