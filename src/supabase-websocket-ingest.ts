import type { LogRecord, LogTransport } from './base-logger.js';

export const SUPABASE_WEBSOCKET_INGEST_PROTOCOL = 'ores-otel/ws-ingest/v1' as const;

type Protocol = typeof SUPABASE_WEBSOCKET_INGEST_PROTOCOL;

export interface SupabaseWebSocketTicket {
  /** `wss://` Edge Function endpoint. The provider may rotate projects/domains. */
  url: string;
  /** Short-lived, one-time ingest ticket. Never return a long-lived user JWT. */
  ticket: string;
  expiresAtMillis?: number;
}

export interface SupabaseTelemetrySession {
  appName: string;
  appVersion?: string;
  runtime: string;
  sessionId: string;
  clientInstanceId: string;
  release?: string;
}

export interface SupabaseWebSocketRecord {
  readonly recordId: string;
  readonly record: LogRecord;
}

export interface SupabaseWebSocketBatch {
  readonly type: 'telemetry_batch';
  readonly protocol: Protocol;
  readonly batchId: string;
  readonly sequence: number;
  readonly sentAt: string;
  readonly session: SupabaseTelemetrySession;
  readonly records: readonly SupabaseWebSocketRecord[];
}

export interface SupabaseWebSocketHelloAck {
  readonly type: 'hello_ack';
  readonly protocol: Protocol;
  readonly serverTime: string;
  readonly maxBatchRecords: number;
  readonly maxBatchBytes: number;
  readonly ackTimeoutMillis: number;
  readonly ticketExpiresAt?: string;
}

export interface SupabaseWebSocketCommitAck {
  readonly type: 'commit_ack';
  readonly protocol: Protocol;
  readonly batchId: string;
  readonly sequence: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly committedAt: string;
}

export interface SupabaseWebSocketServerError {
  readonly type: 'error';
  readonly protocol: Protocol;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMillis?: number;
  readonly batchId?: string;
  readonly rejectedRecordIds?: readonly string[];
}

export interface SupabaseWebSocketSnapshot {
  queued: number;
  inFlight: number;
  accepted: number;
  duplicates: number;
  replayedBatches: number;
  rejected: number;
  dropped: number;
  protocolErrors: number;
  retryAttempts: number;
  reconnects: number;
  connected: boolean;
  helloAcknowledged: boolean;
  accepting: boolean;
  closed: boolean;
  lastAcknowledgedSequence: number;
  negotiatedMaxBatchRecords: number | null;
  negotiatedMaxBatchBytes: number | null;
  negotiatedAcknowledgementTimeoutMillis: number | null;
}

export interface SupabaseWebSocketDrop {
  reason: 'queue-full' | 'record-too-large' | 'closed';
  record: LogRecord;
  droppedTotal: number;
}

export interface SupabaseWebSocketRejection {
  code: string;
  recordId: string;
  record: LogRecord;
  rejectedTotal: number;
}

export interface WebSocketMessageEventLike {
  data: unknown;
}

export interface WebSocketCloseEventLike {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface WebSocketLike {
  readonly readyState: number;
  readonly OPEN?: number;
  binaryType?: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: WebSocketCloseEventLike) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SupabaseWebSocketExitFallback {
  /** Persist the exact same batch ID and return a commit ACK after DB commit. */
  persist(batch: SupabaseWebSocketBatch): Promise<SupabaseWebSocketCommitAck>;
}

export interface SupabaseWebSocketIngestOptions {
  /** Mints a short-lived ticket over authenticated HTTPS. */
  ticketProvider: () => Promise<SupabaseWebSocketTicket>;
  session: SupabaseTelemetrySession;
  /** Exact host allow-list, including an optional port. Empty/omitted trusts the ticket issuer. */
  allowedHosts?: readonly string[];
  webSocketFactory?: (url: string) => WebSocketLike;
  batchSize?: number;
  maxQueueSize?: number;
  maxRecordBytes?: number;
  maxBatchBytes?: number;
  flushIntervalMillis?: number;
  connectTimeoutMillis?: number;
  acknowledgementTimeoutMillis?: number;
  reconnectBaseMillis?: number;
  reconnectMaxMillis?: number;
  maxServerRetryAfterMillis?: number;
  /** Default true. When true, `write()` resolves only after a database commit ACK. */
  awaitAcknowledgement?: boolean;
  /** Default true. Disable only for a legacy collector that cannot negotiate `hello_ack`. */
  requireHelloAcknowledgement?: boolean;
  initialSequence?: number;
  initialLastAcknowledgedSequence?: number;
  clock?: () => Date;
  random?: () => number;
  recordIdFactory?: () => string;
  batchIdFactory?: () => string;
  exitFallback?: SupabaseWebSocketExitFallback;
  onDrop?: (drop: SupabaseWebSocketDrop) => void;
  onRejected?: (rejection: SupabaseWebSocketRejection) => void;
  onHelloAcknowledged?: (acknowledgement: SupabaseWebSocketHelloAck) => void;
  onAcknowledged?: (acknowledgement: SupabaseWebSocketCommitAck) => void;
  onProtocolError?: (error: unknown, snapshot: SupabaseWebSocketSnapshot) => void;
  onError?: (error: unknown, snapshot: SupabaseWebSocketSnapshot) => void;
}

interface QueuedRecord {
  readonly recordId: string;
  readonly record: LogRecord;
  readonly bytes: number;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

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

  prepend(values: readonly T[]): void {
    if (values.length === 0) return;
    this.values = [...values, ...this.values.slice(this.head)];
    this.head = 0;
  }
}

export class SupabaseWebSocketProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseWebSocketProtocolError';
  }
}

export class SupabaseWebSocketRejectedError extends Error {
  readonly code: string;
  readonly rejectedRecordIds: readonly string[];

  constructor(code: string, rejectedRecordIds: readonly string[]) {
    super(`Supabase telemetry batch rejected (${code}): ${rejectedRecordIds.join(', ')}`);
    this.name = 'SupabaseWebSocketRejectedError';
    this.code = code;
    this.rejectedRecordIds = rejectedRecordIds;
  }
}

function byteLength(value: string): number {
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.length;
}

function randomId(): string {
  const cryptoValue = globalThis.crypto;
  if (cryptoValue?.randomUUID) return cryptoValue.randomUUID();
  if (cryptoValue?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoValue.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function timerUnref(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
  candidate.unref?.();
}

function isOpen(socket: WebSocketLike | null): socket is WebSocketLike {
  if (!socket) return false;
  const open = socket.OPEN ?? 1;
  return socket.readyState === open;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new SupabaseWebSocketProtocolError(`${label} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new SupabaseWebSocketProtocolError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function validateTicket(
  ticket: SupabaseWebSocketTicket,
  allowedHosts: readonly string[] | undefined,
  nowMillis: number,
): URL {
  if (!ticket.ticket || ticket.ticket.trim().length < 16) {
    throw new TypeError('Supabase WebSocket ingest requires a non-empty short-lived ticket');
  }
  if (ticket.expiresAtMillis !== undefined && ticket.expiresAtMillis <= nowMillis) {
    throw new Error('Supabase WebSocket ingest ticket is already expired');
  }
  const url = new URL(ticket.url);
  if (url.protocol !== 'wss:') {
    throw new TypeError(`Supabase WebSocket ingest requires wss://, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new TypeError('Supabase WebSocket ingest URL must not contain embedded credentials');
  }
  if (allowedHosts && allowedHosts.length > 0) {
    const normalized = new Set(allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
    if (!normalized.has(url.host.toLowerCase())) {
      throw new TypeError(`Supabase WebSocket ingest host is not allowed: ${url.host}`);
    }
  }
  url.hash = '';
  url.searchParams.set('ticket', ticket.ticket.trim());
  return url;
}

async function parseMessageData(data: unknown): Promise<unknown> {
  if (typeof data === 'string') return JSON.parse(data);
  if (data instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(data)));
  }
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(
      new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    );
  }
  if (typeof Blob === 'function' && data instanceof Blob) {
    return JSON.parse(await data.text());
  }
  throw new SupabaseWebSocketProtocolError('Unsupported WebSocket message payload type');
}

function parseHelloAck(value: unknown): SupabaseWebSocketHelloAck {
  if (!isObject(value)) {
    throw new SupabaseWebSocketProtocolError('Hello acknowledgement must be an object');
  }
  if (value.type !== 'hello_ack' || value.protocol !== SUPABASE_WEBSOCKET_INGEST_PROTOCOL) {
    throw new SupabaseWebSocketProtocolError('Unexpected hello acknowledgement type or protocol');
  }
  if (!validDateString(value.serverTime)) {
    throw new SupabaseWebSocketProtocolError('Hello acknowledgement has invalid serverTime');
  }
  const result: SupabaseWebSocketHelloAck = {
    type: 'hello_ack',
    protocol: SUPABASE_WEBSOCKET_INGEST_PROTOCOL,
    serverTime: value.serverTime,
    maxBatchRecords: positiveInteger(value.maxBatchRecords, 'maxBatchRecords'),
    maxBatchBytes: positiveInteger(value.maxBatchBytes, 'maxBatchBytes'),
    ackTimeoutMillis: positiveInteger(value.ackTimeoutMillis, 'ackTimeoutMillis'),
    ...(value.ticketExpiresAt === undefined
      ? {}
      : validDateString(value.ticketExpiresAt)
        ? { ticketExpiresAt: value.ticketExpiresAt }
        : (() => { throw new SupabaseWebSocketProtocolError('Hello acknowledgement has invalid ticketExpiresAt'); })()),
  };
  return result;
}

function parseCommitAck(value: unknown): SupabaseWebSocketCommitAck {
  if (!isObject(value)) {
    throw new SupabaseWebSocketProtocolError('Commit acknowledgement must be an object');
  }
  if (value.type !== 'commit_ack' || value.protocol !== SUPABASE_WEBSOCKET_INGEST_PROTOCOL) {
    throw new SupabaseWebSocketProtocolError('Unexpected commit acknowledgement type or protocol');
  }
  if (typeof value.batchId !== 'string' || value.batchId.length === 0) {
    throw new SupabaseWebSocketProtocolError('Commit acknowledgement has invalid batchId');
  }
  if (!validDateString(value.committedAt)) {
    throw new SupabaseWebSocketProtocolError('Commit acknowledgement has invalid committedAt');
  }
  return {
    type: 'commit_ack',
    protocol: SUPABASE_WEBSOCKET_INGEST_PROTOCOL,
    batchId: value.batchId,
    sequence: nonNegativeInteger(value.sequence, 'sequence'),
    accepted: nonNegativeInteger(value.accepted, 'accepted'),
    duplicates: nonNegativeInteger(value.duplicates, 'duplicates'),
    committedAt: value.committedAt,
  };
}

function parseServerError(value: unknown): SupabaseWebSocketServerError {
  if (!isObject(value)) {
    throw new SupabaseWebSocketProtocolError('Server error must be an object');
  }
  if (value.type !== 'error' || value.protocol !== SUPABASE_WEBSOCKET_INGEST_PROTOCOL) {
    throw new SupabaseWebSocketProtocolError('Unexpected server error type or protocol');
  }
  if (typeof value.code !== 'string' || value.code.trim().length === 0) {
    throw new SupabaseWebSocketProtocolError('Server error has invalid code');
  }
  if (typeof value.retryable !== 'boolean') {
    throw new SupabaseWebSocketProtocolError('Server error has invalid retryable flag');
  }
  if (value.retryAfterMillis !== undefined) {
    nonNegativeInteger(value.retryAfterMillis, 'retryAfterMillis');
  }
  if (value.batchId !== undefined && typeof value.batchId !== 'string') {
    throw new SupabaseWebSocketProtocolError('Server error has invalid batchId');
  }
  let rejectedRecordIds: readonly string[] | undefined;
  if (value.rejectedRecordIds !== undefined) {
    if (!Array.isArray(value.rejectedRecordIds) ||
        !value.rejectedRecordIds.every((item) => typeof item === 'string' && item.length > 0)) {
      throw new SupabaseWebSocketProtocolError('Server error has invalid rejectedRecordIds');
    }
    rejectedRecordIds = [...new Set(value.rejectedRecordIds as string[])];
  }
  return {
    type: 'error',
    protocol: SUPABASE_WEBSOCKET_INGEST_PROTOCOL,
    code: value.code,
    retryable: value.retryable,
    ...(value.retryAfterMillis === undefined ? {} : { retryAfterMillis: value.retryAfterMillis as number }),
    ...(value.batchId === undefined ? {} : { batchId: value.batchId }),
    ...(rejectedRecordIds === undefined ? {} : { rejectedRecordIds }),
  };
}

/**
 * Replay-safe browser/Flutter-web transport. Records remain in-flight until the
 * collector acknowledges a successful project-specific Supabase transaction.
 * A Realtime/Broadcast send acknowledgement is never accepted as durability proof.
 */
export class SupabaseWebSocketIngestTransport implements LogTransport {
  readonly name = 'supabase-websocket-ingest';
  readonly options: Readonly<SupabaseWebSocketIngestOptions>;

  private readonly queue = new CursorQueue<QueuedRecord>();
  private readonly sentBatchIds = new Set<string>();
  private socket: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private flushPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private inFlight: SupabaseWebSocketBatch | null = null;
  private inFlightPayload: string | null = null;
  private ackWaiter: Waiter<SupabaseWebSocketCommitAck> | null = null;
  private helloWaiter: Waiter<SupabaseWebSocketHelloAck> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private serverRetryAfterMillis = 0;
  private nextSequence: number;
  private lastAcknowledgedSequence: number;
  private helloAcknowledged = false;
  private negotiatedMaxBatchRecords: number | null = null;
  private negotiatedMaxBatchBytes: number | null = null;
  private negotiatedAcknowledgementTimeoutMillis: number | null = null;
  private accepted = 0;
  private duplicates = 0;
  private replayedBatches = 0;
  private rejected = 0;
  private dropped = 0;
  private protocolErrors = 0;
  private retryAttempts = 0;
  private reconnects = 0;
  private accepting = true;
  private closed = false;

  constructor(options: SupabaseWebSocketIngestOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('SupabaseWebSocketIngestTransport requires options');
    }
    if (typeof options.ticketProvider !== 'function') {
      throw new TypeError('ticketProvider is required');
    }
    if (!options.session?.appName || !options.session.runtime ||
        !options.session.sessionId || !options.session.clientInstanceId) {
      throw new TypeError('session requires appName, runtime, sessionId, and clientInstanceId');
    }
    const initialLast = options.initialLastAcknowledgedSequence ?? 0;
    if (!Number.isInteger(initialLast) || initialLast < 0) {
      throw new TypeError('initialLastAcknowledgedSequence must be a non-negative integer');
    }
    const initialSequence = options.initialSequence ?? initialLast + 1;
    if (!Number.isInteger(initialSequence) || initialSequence <= initialLast) {
      throw new TypeError('initialSequence must be an integer greater than the last acknowledged sequence');
    }
    this.options = options;
    this.lastAcknowledgedSequence = initialLast;
    this.nextSequence = initialSequence;
  }

  snapshot(): SupabaseWebSocketSnapshot {
    return {
      queued: this.queue.length,
      inFlight: this.inFlight?.records.length ?? 0,
      accepted: this.accepted,
      duplicates: this.duplicates,
      replayedBatches: this.replayedBatches,
      rejected: this.rejected,
      dropped: this.dropped,
      protocolErrors: this.protocolErrors,
      retryAttempts: this.retryAttempts,
      reconnects: this.reconnects,
      connected: isOpen(this.socket) && this.helloAcknowledged,
      helloAcknowledged: this.helloAcknowledged,
      accepting: this.accepting,
      closed: this.closed,
      lastAcknowledgedSequence: this.lastAcknowledgedSequence,
      negotiatedMaxBatchRecords: this.negotiatedMaxBatchRecords,
      negotiatedMaxBatchBytes: this.negotiatedMaxBatchBytes,
      negotiatedAcknowledgementTimeoutMillis: this.negotiatedAcknowledgementTimeoutMillis,
    };
  }

  private now(): Date {
    const value = (this.options.clock ?? (() => new Date()))();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError('clock must return a valid Date');
    }
    return value;
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error, this.snapshot());
    } catch {
      // Diagnostics must never recursively fail telemetry delivery.
    }
  }

  private reportProtocolError(error: unknown): void {
    this.protocolErrors += 1;
    try {
      this.options.onProtocolError?.(error, this.snapshot());
    } catch {
      // Diagnostics must never recursively fail telemetry delivery.
    }
  }

  private drop(record: LogRecord, reason: SupabaseWebSocketDrop['reason']): void {
    this.dropped += 1;
    try {
      this.options.onDrop?.({ reason, record, droppedTotal: this.dropped });
    } catch {
      // Diagnostics do not alter queue accounting.
    }
  }

  private rejectRecord(code: string, recordId: string, record: LogRecord): void {
    this.rejected += 1;
    try {
      this.options.onRejected?.({ code, recordId, record, rejectedTotal: this.rejected });
    } catch {
      // Diagnostics do not alter rejection accounting.
    }
  }

  private enqueue(record: LogRecord): boolean {
    if (!this.accepting) {
      this.drop(record, 'closed');
      return false;
    }
    let snapshot: LogRecord;
    let bytes: number;
    const recordId = (this.options.recordIdFactory ?? randomId)();
    if (!recordId || typeof recordId !== 'string') {
      throw new TypeError('recordIdFactory must return a non-empty string');
    }
    try {
      const encoded = JSON.stringify({ recordId, record });
      bytes = byteLength(encoded);
      snapshot = JSON.parse(JSON.stringify(record)) as LogRecord;
    } catch (error) {
      throw new TypeError(`Supabase telemetry record is not JSON serializable: ${String(error)}`);
    }
    if (bytes > Math.max(1, this.options.maxRecordBytes ?? 128 * 1_024)) {
      this.drop(snapshot, 'record-too-large');
      return false;
    }
    const maximum = Math.max(1, this.options.maxQueueSize ?? 2_000);
    const pending = this.queue.length + (this.inFlight?.records.length ?? 0);
    if (pending >= maximum) {
      const oldest = this.queue.shift();
      if (oldest) {
        this.drop(oldest.record, 'queue-full');
      } else {
        this.drop(snapshot, 'queue-full');
        return false;
      }
    }
    this.queue.push({ recordId, record: snapshot, bytes });
    return true;
  }

  async write(record: LogRecord): Promise<void> {
    if (!this.enqueue(record)) return;
    const batchSize = Math.max(1, this.options.batchSize ?? 50);
    if (this.queue.length >= batchSize || this.options.awaitAcknowledgement === true) {
      const delivery = this.flush();
      if (this.options.awaitAcknowledgement === true) {
        await delivery;
      } else {
        void delivery.catch(() => undefined);
      }
      return;
    }
    this.scheduleFlush();
    void this.ensureConnected().catch((error) => {
      this.reportError(error);
      this.scheduleReconnect();
    });
  }

  private effectiveBatchSize(): number {
    const client = Math.max(1, this.options.batchSize ?? 50);
    return this.negotiatedMaxBatchRecords === null
      ? client
      : Math.min(client, this.negotiatedMaxBatchRecords);
  }

  private effectiveBatchBytes(): number {
    const client = Math.max(1_024, this.options.maxBatchBytes ?? 480 * 1_024);
    return this.negotiatedMaxBatchBytes === null
      ? client
      : Math.min(client, this.negotiatedMaxBatchBytes);
  }

  private createBatch(): SupabaseWebSocketBatch | null {
    if (this.inFlight) return this.inFlight;
    const maximumRecords = this.effectiveBatchSize();
    const maximumBytes = this.effectiveBatchBytes();
    const batchId = (this.options.batchIdFactory ?? randomId)();
    if (!batchId || typeof batchId !== 'string') {
      throw new TypeError('batchIdFactory must return a non-empty string');
    }
    const sequence = this.nextSequence;
    const sentAt = this.now().toISOString();
    const records: SupabaseWebSocketRecord[] = [];
    let payload = '';

    while (records.length < maximumRecords && this.queue.length > 0) {
      const queued = this.queue.shift();
      if (!queued) break;
      const candidateRecords = [...records, { recordId: queued.recordId, record: queued.record }];
      const candidate: SupabaseWebSocketBatch = {
        type: 'telemetry_batch',
        protocol: SUPABASE_WEBSOCKET_INGEST_PROTOCOL,
        batchId,
        sequence,
        sentAt,
        session: this.options.session,
        records: candidateRecords,
      };
      const candidatePayload = JSON.stringify(candidate);
      if (byteLength(candidatePayload) > maximumBytes) {
        if (records.length === 0) {
          this.drop(queued.record, 'record-too-large');
          continue;
        }
        this.queue.prepend([queued]);
        break;
      }
      records.push({ recordId: queued.recordId, record: queued.record });
      payload = candidatePayload;
    }

    if (records.length === 0) return null;
    this.inFlight = {
      type: 'telemetry_batch',
      protocol: SUPABASE_WEBSOCKET_INGEST_PROTOCOL,
      batchId,
      sequence,
      sentAt,
      session: this.options.session,
      records,
    };
    this.inFlightPayload = payload || JSON.stringify(this.inFlight);
    this.nextSequence += 1;
    return this.inFlight;
  }

  private scheduleFlush(): void {
    if (!this.accepting || this.flushTimer || (this.queue.length === 0 && !this.inFlight)) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => undefined);
    }, Math.max(10, this.options.flushIntervalMillis ?? 1_000));
    timerUnref(this.flushTimer);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.accepting || this.reconnectTimer || isOpen(this.socket) ||
        (this.queue.length === 0 && !this.inFlight)) return;
    const base = Math.max(25, this.options.reconnectBaseMillis ?? 500);
    const maximum = Math.max(base, this.options.reconnectMaxMillis ?? 30_000);
    const exponential = Math.min(maximum, base * 2 ** Math.min(this.reconnectAttempts, 20));
    const jitter = 0.8 + (this.options.random ?? Math.random)() * 0.4;
    const serverDelay = Math.min(
      Math.max(0, this.options.maxServerRetryAfterMillis ?? 120_000),
      this.serverRetryAfterMillis,
    );
    const delay = Math.max(exponential * jitter, serverDelay);
    this.serverRetryAfterMillis = 0;
    this.reconnectAttempts += 1;
    this.retryAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnects += 1;
      void this.flush().catch(() => undefined);
    }, delay);
    timerUnref(this.reconnectTimer);
  }

  private webSocketFactory(url: string): WebSocketLike {
    if (this.options.webSocketFactory) return this.options.webSocketFactory(url);
    if (typeof WebSocket !== 'function') {
      throw new Error('No WebSocket implementation is available');
    }
    return new WebSocket(url) as unknown as WebSocketLike;
  }

  private resolveHello(acknowledgement: SupabaseWebSocketHelloAck): void {
    const waiter = this.helloWaiter;
    if (!waiter) {
      throw new SupabaseWebSocketProtocolError('Received an unexpected or duplicate hello ACK');
    }
    this.helloWaiter = null;
    clearTimeout(waiter.timer);
    this.helloAcknowledged = true;
    this.negotiatedMaxBatchRecords = acknowledgement.maxBatchRecords;
    this.negotiatedMaxBatchBytes = acknowledgement.maxBatchBytes;
    this.negotiatedAcknowledgementTimeoutMillis = acknowledgement.ackTimeoutMillis;
    this.reconnectAttempts = 0;
    waiter.resolve(acknowledgement);
    try {
      this.options.onHelloAcknowledged?.(acknowledgement);
    } catch {
      // Diagnostics do not alter connection state.
    }
  }

  private rejectHello(error: unknown): void {
    const waiter = this.helloWaiter;
    if (!waiter) return;
    this.helloWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private async openSocket(): Promise<void> {
    const ticket = await this.options.ticketProvider();
    const url = validateTicket(ticket, this.options.allowedHosts, this.now().getTime());
    url.searchParams.set('client_instance_id', this.options.session.clientInstanceId);
    url.searchParams.set('last_acked_sequence', String(this.lastAcknowledgedSequence));
    const socket = this.webSocketFactory(url.toString());
    this.socket = socket;
    this.helloAcknowledged = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finishResolve = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const finishReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const timeout = setTimeout(() => {
        const error = new Error('Supabase telemetry WebSocket hello acknowledgement timed out');
        this.rejectHello(error);
        try { socket.close(4000, 'hello timeout'); } catch { /* noop */ }
        finishReject(error);
      }, Math.max(100, this.options.connectTimeoutMillis ?? 10_000));
      timerUnref(timeout);

      if (this.options.requireHelloAcknowledgement !== false) {
        this.helloWaiter = {
          timer: timeout,
          resolve: () => finishResolve(),
          reject: (error) => finishReject(error),
        };
      }

      socket.onmessage = (event) => {
        void this.handleMessage(event, socket).catch((error) => this.protocolFailure(error, socket));
      };
      socket.onerror = (event) => {
        if (!settled) {
          const error = new Error(`Supabase telemetry WebSocket connection error: ${String(event)}`);
          this.rejectHello(error);
          clearTimeout(timeout);
          finishReject(error);
        } else {
          this.reportError(new Error(`Supabase telemetry WebSocket error: ${String(event)}`));
        }
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.helloAcknowledged = false;
        const error = new Error(
          `Supabase telemetry WebSocket closed before commit ACK` +
            (event.code === undefined ? '' : ` (${event.code}${event.reason ? `: ${event.reason}` : ''})`),
        );
        this.rejectHello(error);
        this.rejectAckWaiter(error);
        clearTimeout(timeout);
        finishReject(error);
        this.scheduleReconnect();
      };
      socket.onopen = () => {
        const hello = {
          type: 'hello',
          protocol: SUPABASE_WEBSOCKET_INGEST_PROTOCOL,
          session: this.options.session,
          lastAcknowledgedSequence: this.lastAcknowledgedSequence,
        };
        try {
          socket.send(JSON.stringify(hello));
          if (this.options.requireHelloAcknowledgement === false) {
            clearTimeout(timeout);
            this.helloAcknowledged = true;
            this.reconnectAttempts = 0;
            finishResolve();
          }
        } catch (error) {
          this.rejectHello(error);
          clearTimeout(timeout);
          finishReject(error);
        }
      };
    });
  }

  private ensureConnected(): Promise<void> {
    if (isOpen(this.socket) && this.helloAcknowledged) return Promise.resolve();
    this.connectPromise ??= this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private protocolFailure(error: unknown, socket: WebSocketLike): void {
    this.reportProtocolError(error);
    if (this.socket === socket) {
      try { socket.close(4002, 'protocol error'); } catch { /* noop */ }
    }
  }

  private async handleMessage(event: WebSocketMessageEventLike, socket: WebSocketLike): Promise<void> {
    if (this.socket !== socket) return;
    const value = await parseMessageData(event.data);
    if (!isObject(value) || typeof value.type !== 'string') {
      throw new SupabaseWebSocketProtocolError('WebSocket message must contain a type');
    }
    switch (value.type) {
      case 'hello_ack':
        this.resolveHello(parseHelloAck(value));
        return;
      case 'commit_ack':
        if (!this.helloAcknowledged) {
          throw new SupabaseWebSocketProtocolError('Commit ACK arrived before hello ACK');
        }
        this.acceptCommit(parseCommitAck(value));
        return;
      case 'error':
        this.handleServerError(parseServerError(value), socket);
        return;
      default:
        throw new SupabaseWebSocketProtocolError(`Unexpected WebSocket message type: ${value.type}`);
    }
  }

  private validateAckForBatch(
    acknowledgement: SupabaseWebSocketCommitAck,
    batch: SupabaseWebSocketBatch,
  ): void {
    if (acknowledgement.batchId !== batch.batchId || acknowledgement.sequence !== batch.sequence) {
      throw new SupabaseWebSocketProtocolError('Commit ACK does not match the in-flight batch');
    }
    if (acknowledgement.accepted + acknowledgement.duplicates !== batch.records.length) {
      throw new SupabaseWebSocketProtocolError('Commit ACK accounting does not equal the batch size');
    }
  }

  private acceptCommit(acknowledgement: SupabaseWebSocketCommitAck): void {
    const batch = this.inFlight;
    if (!batch) throw new SupabaseWebSocketProtocolError('Received commit ACK with no in-flight batch');
    this.validateAckForBatch(acknowledgement, batch);
    this.accepted += acknowledgement.accepted;
    this.duplicates += acknowledgement.duplicates;
    this.lastAcknowledgedSequence = acknowledgement.sequence;
    this.sentBatchIds.delete(acknowledgement.batchId);
    this.inFlight = null;
    this.inFlightPayload = null;
    this.resolveAckWaiter(acknowledgement);
    try {
      this.options.onAcknowledged?.(acknowledgement);
    } catch {
      // Diagnostics do not alter delivery semantics.
    }
  }

  private handleServerError(
    serverError: SupabaseWebSocketServerError,
    socket: WebSocketLike,
  ): void {
    const batch = this.inFlight;
    if (serverError.batchId !== undefined && serverError.batchId !== batch?.batchId) {
      throw new SupabaseWebSocketProtocolError('Server error does not match the in-flight batch');
    }
    if (serverError.retryable) {
      this.serverRetryAfterMillis = serverError.retryAfterMillis ?? 0;
      const error = new Error(`Supabase telemetry collector returned retryable error: ${serverError.code}`);
      this.rejectAckWaiter(error);
      if (this.socket === socket) {
        try { socket.close(4013, 'retryable server error'); } catch { /* noop */ }
      }
      return;
    }
    if (!batch) {
      throw new SupabaseWebSocketProtocolError('Terminal server error arrived with no in-flight batch');
    }
    const rejectedIds = serverError.rejectedRecordIds;
    if (!rejectedIds || rejectedIds.length === 0) {
      throw new SupabaseWebSocketProtocolError('Terminal server error must identify rejected record IDs');
    }
    const batchIds = new Set(batch.records.map(({ recordId }) => recordId));
    if (rejectedIds.some((recordId) => !batchIds.has(recordId))) {
      throw new SupabaseWebSocketProtocolError('Terminal server error contains an unknown record ID');
    }
    const rejectedSet = new Set(rejectedIds);
    const retained: QueuedRecord[] = [];
    for (const item of batch.records) {
      if (rejectedSet.has(item.recordId)) {
        this.rejectRecord(serverError.code, item.recordId, item.record);
      } else {
        retained.push({
          recordId: item.recordId,
          record: item.record,
          bytes: byteLength(JSON.stringify(item)),
        });
      }
    }
    this.queue.prepend(retained);
    this.sentBatchIds.delete(batch.batchId);
    this.inFlight = null;
    this.inFlightPayload = null;
    this.rejectAckWaiter(new SupabaseWebSocketRejectedError(serverError.code, rejectedIds));
  }

  private resolveAckWaiter(acknowledgement: SupabaseWebSocketCommitAck): void {
    const waiter = this.ackWaiter;
    if (!waiter) return;
    this.ackWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(acknowledgement);
  }

  private rejectAckWaiter(error: unknown): void {
    const waiter = this.ackWaiter;
    if (!waiter) return;
    this.ackWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private waitForCommit(batch: SupabaseWebSocketBatch): Promise<SupabaseWebSocketCommitAck> {
    if (this.ackWaiter) {
      throw new Error('Only one telemetry batch may be in flight');
    }
    const clientTimeout = Math.max(100, this.options.acknowledgementTimeoutMillis ?? 15_000);
    const timeoutMillis = this.negotiatedAcknowledgementTimeoutMillis === null
      ? clientTimeout
      : Math.min(clientTimeout, this.negotiatedAcknowledgementTimeoutMillis);
    return new Promise<SupabaseWebSocketCommitAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.ackWaiter) return;
        this.ackWaiter = null;
        try { this.socket?.close(4001, 'commit ACK timeout'); } catch { /* noop */ }
        reject(new Error(`Timed out waiting for commit ACK for batch ${batch.batchId}`));
      }, timeoutMillis);
      timerUnref(timer);
      this.ackWaiter = { resolve, reject, timer };
    });
  }

  private async sendInFlight(): Promise<SupabaseWebSocketCommitAck> {
    const batch = this.inFlight;
    const payload = this.inFlightPayload;
    if (!batch || !payload) throw new Error('No in-flight telemetry batch');
    await this.ensureConnected();
    if (!isOpen(this.socket) || !this.helloAcknowledged) {
      throw new Error('Telemetry WebSocket is not authenticated and ready');
    }
    if (this.sentBatchIds.has(batch.batchId)) {
      this.replayedBatches += 1;
    }
    const acknowledgement = this.waitForCommit(batch);
    try {
      this.socket.send(payload);
      this.sentBatchIds.add(batch.batchId);
    } catch (error) {
      this.rejectAckWaiter(error);
      throw error;
    }
    return acknowledgement;
  }

  private async drain(): Promise<void> {
    this.clearFlushTimer();
    while (this.inFlight || this.queue.length > 0) {
      // Negotiate server limits before constructing a new batch. An existing
      // in-flight batch is immutable and must be replayed byte-for-byte.
      if (!this.inFlight) await this.ensureConnected();
      const batch = this.createBatch();
      if (!batch) return;
      await this.sendInFlight();
    }
  }

  flush(): Promise<void> {
    this.flushPromise ??= this.drain()
      .catch((error) => {
        this.reportError(error);
        if (!(error instanceof SupabaseWebSocketRejectedError)) {
          this.scheduleReconnect();
        }
        throw error;
      })
      .finally(() => {
        this.flushPromise = null;
        if ((this.queue.length > 0 || this.inFlight) && this.accepting) {
          this.scheduleFlush();
        }
      });
    return this.flushPromise;
  }

  async flushOnExit(): Promise<void> {
    this.clearFlushTimer();
    if (this.flushPromise) {
      try {
        await this.flushPromise;
      } catch {
        // Preserve the immutable in-flight batch for the HTTPS fallback below.
      }
    }
    if (!this.options.exitFallback) {
      await this.flush();
      return;
    }
    while (this.inFlight || this.queue.length > 0) {
      const batch = this.createBatch();
      if (!batch) return;
      const acknowledgement = parseCommitAck(await this.options.exitFallback.persist(batch));
      this.validateAckForBatch(acknowledgement, batch);
      this.accepted += acknowledgement.accepted;
      this.duplicates += acknowledgement.duplicates;
      this.lastAcknowledgedSequence = acknowledgement.sequence;
      this.sentBatchIds.delete(batch.batchId);
      this.inFlight = null;
      this.inFlightPayload = null;
      try {
        this.options.onAcknowledged?.(acknowledgement);
      } catch {
        // Diagnostics do not alter delivery semantics.
      }
    }
  }

  private async performClose(): Promise<void> {
    if (this.closed) return;
    this.accepting = false;
    this.clearFlushTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.flushOnExit();
    const socket = this.socket;
    this.socket = null;
    this.helloAcknowledged = false;
    try { socket?.close(1000, 'telemetry transport closed'); } catch { /* noop */ }
    this.closed = true;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closePromise ??= this.performClose().finally(() => {
      this.closePromise = null;
    });
    return this.closePromise;
  }
}

export function createSupabaseWebSocketIngestTransport(
  options: SupabaseWebSocketIngestOptions,
): SupabaseWebSocketIngestTransport {
  return new SupabaseWebSocketIngestTransport(options);
}
