import type { LogRecord, LogTransport } from './base-logger.js';

export interface SupabaseIngestDrop {
  reason: 'queue-full' | 'record-too-large' | 'closed';
  record: LogRecord;
  droppedTotal: number;
}

export interface SupabaseIngestSnapshot {
  queued: number;
  dropped: number;
  failures: number;
  retryAttempts: number;
  accepting: boolean;
  closed: boolean;
}

export interface SupabaseIngestOptions {
  /** Supabase project URL or complete Edge Function URL. */
  url: string;
  /** Client-safe sb_publishable_* key (legacy anon keys also work during migration). */
  publishableKey: string;
  /** User access token. Never pass a service-role or sb_secret_* key. */
  accessToken?: string | (() => string | undefined | Promise<string | undefined>);
  /**
   * Authenticated ingestion is the safe default. Set this only when the Edge
   * Function is deliberately configured for publishable-key-only ingestion.
   */
  allowUnauthenticated?: boolean;
  functionName?: string;
  batchSize?: number;
  maxQueueSize?: number;
  maxRecordBytes?: number;
  /** Maximum serialized records per ordinary request. Default 480 KiB. */
  maxBatchBytes?: number;
  /** Smaller keepalive budget used during page/process exit. Default 60 KiB. */
  maxExitBatchBytes?: number;
  flushIntervalMillis?: number;
  /** Set to 0 to disable request timeout. Default 10 seconds. */
  timeoutMillis?: number;
  retryBaseMillis?: number;
  retryMaxMillis?: number;
  fetch?: typeof fetch;
  awaitDelivery?: boolean;
  /** Testable clock used for batch sentAt. */
  clock?: () => Date;
  /** Testable source of retry jitter in the range [0, 1]. */
  random?: () => number;
  onDrop?: (drop: SupabaseIngestDrop) => void;
  onError?: (error: unknown, snapshot: SupabaseIngestSnapshot) => void;
}

interface ResolvedOptions {
  batchSize: number;
  maxQueueSize: number;
  maxRecordBytes: number;
  maxBatchBytes: number;
  maxExitBatchBytes: number;
  flushIntervalMillis: number;
  timeoutMillis: number;
  retryBaseMillis: number;
  retryMaxMillis: number;
}

interface QueuedRecord {
  record: LogRecord;
  encoded: string;
  bytes: number;
}

const BATCH_SCHEMA = 'next-loggers/batch/v1';
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_QUEUE_SIZE = 2_000;
const DEFAULT_MAX_RECORD_BYTES = 128 * 1_024;
const DEFAULT_MAX_BATCH_BYTES = 480 * 1_024;
const DEFAULT_MAX_EXIT_BATCH_BYTES = 60 * 1_024;
const DEFAULT_FLUSH_INTERVAL_MILLIS = 1_000;
const DEFAULT_TIMEOUT_MILLIS = 10_000;
const DEFAULT_RETRY_BASE_MILLIS = 500;
const DEFAULT_RETRY_MAX_MILLIS = 30_000;
const BATCH_ENVELOPE_BUDGET = 512;

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
    if (this.head >= this.values.length) {
      return undefined;
    }
    const value = this.values[this.head];
    this.head += 1;
    this.compact();
    return value;
  }

  prepend(values: readonly T[]): void {
    if (values.length === 0) {
      return;
    }
    const remaining = this.values.slice(this.head);
    this.values = [...values, ...remaining];
    this.head = 0;
  }

  private compact(): void {
    if (this.head > 1_024 && this.head * 2 > this.values.length) {
      this.values = this.values.slice(this.head);
      this.head = 0;
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
}

function decodeBase64Url(value: string): string | undefined {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/u, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) {
      return undefined;
    }
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
}

function decodeJwtRole(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    const decoded = decodeBase64Url(payload);
    if (!decoded) {
      return undefined;
    }
    const claims = JSON.parse(decoded) as { role?: unknown };
    return typeof claims.role === 'string' ? claims.role : undefined;
  } catch {
    return undefined;
  }
}

function assertClientCredential(value: string, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new TypeError(`SupabaseIngestTransport requires ${label}`);
  }
  if (normalized.startsWith('sb_secret_') || /service[_-]?role/iu.test(normalized)) {
    throw new TypeError(`Secret/service-role Supabase credentials must never be used as ${label}`);
  }
  if (decodeJwtRole(normalized) === 'service_role') {
    throw new TypeError(`A service-role JWT must never be used as ${label}`);
  }
  return normalized;
}

function assertClientToken(token: string | undefined, allowUnauthenticated: boolean): string | undefined {
  if (!token) {
    if (!allowUnauthenticated) {
      throw new Error(
        'Supabase telemetry ingestion requires a user access token; ' +
          'set allowUnauthenticated only for a deliberately publishable-key-only function',
      );
    }
    return undefined;
  }
  return assertClientCredential(token, 'a user access token');
}

function functionUrl(url: string, functionName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`Supabase ingest URL must be valid, got: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Supabase ingest URL must use http(s), got ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('Supabase ingest URL must not contain embedded credentials');
  }
  parsed.search = '';
  parsed.hash = '';
  const marker = '/functions/v1/';
  if (!parsed.pathname.includes(marker)) {
    const name = functionName.trim();
    if (!name) {
      throw new TypeError('Supabase Edge Function name must not be empty');
    }
    parsed.pathname = `${marker}${encodeURIComponent(name)}`;
  } else if (!parsed.pathname.split(marker)[1]?.replace(/^\/+|\/+$/gu, '')) {
    throw new TypeError('Supabase ingest URL must include an Edge Function name');
  }
  return parsed.toString();
}

function timerUnref(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
  candidate.unref?.();
}

function byteLength(value: string): number {
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.length;
}

async function resolveToken(
  value: SupabaseIngestOptions['accessToken'],
): Promise<string | undefined> {
  const token = typeof value === 'function' ? await value() : value;
  if (token === undefined) {
    return undefined;
  }
  if (typeof token !== 'string') {
    throw new TypeError('Supabase accessToken callback must return a string or undefined');
  }
  return token.trim() || undefined;
}

function hashBatch(records: readonly QueuedRecord[]): string {
  let hash = 0x811c9dc5;
  for (const item of records) {
    const value = `${item.record.id}\u0000${item.record.timestamp}\u0000`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `nl-${records.length}-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Durable client transport for a Supabase Edge Function. It is independent of
 * Supabase Realtime: applications can add the existing realtime transport as a
 * second transport when they also want live tailing.
 */
export class SupabaseIngestTransport implements LogTransport {
  readonly name = 'supabase-ingest';
  readonly endpoint: string;

  private readonly options: Readonly<SupabaseIngestOptions>;

  private readonly queue = new CursorQueue<QueuedRecord>();
  private readonly resolved: ResolvedOptions;
  private readonly publishableKey: string;
  private flushPromise: Promise<void> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempts = 0;
  private dropped = 0;
  private failures = 0;
  private accepting = true;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: SupabaseIngestOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('SupabaseIngestTransport requires options');
    }
    this.publishableKey = assertClientCredential(options.publishableKey, 'a publishable key');
    this.options = options;
    this.endpoint = functionUrl(options.url, options.functionName ?? 'telemetry-ingest');

    const maxBatchBytes = Math.max(
      1_024,
      positiveInteger(options.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES),
    );
    const maxRecordBytes = Math.min(
      positiveInteger(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES),
      Math.max(1, maxBatchBytes - BATCH_ENVELOPE_BUDGET),
    );
    const retryBaseMillis = Math.max(
      10,
      positiveInteger(options.retryBaseMillis, DEFAULT_RETRY_BASE_MILLIS),
    );
    this.resolved = {
      batchSize: positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE),
      maxQueueSize: positiveInteger(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE),
      maxRecordBytes,
      maxBatchBytes,
      maxExitBatchBytes: Math.max(
        1_024,
        positiveInteger(options.maxExitBatchBytes, DEFAULT_MAX_EXIT_BATCH_BYTES),
      ),
      flushIntervalMillis: Math.max(
        10,
        positiveInteger(options.flushIntervalMillis, DEFAULT_FLUSH_INTERVAL_MILLIS),
      ),
      timeoutMillis: nonNegativeInteger(options.timeoutMillis, DEFAULT_TIMEOUT_MILLIS),
      retryBaseMillis,
      retryMaxMillis: Math.max(
        retryBaseMillis,
        positiveInteger(options.retryMaxMillis, DEFAULT_RETRY_MAX_MILLIS),
      ),
    };
  }

  snapshot(): SupabaseIngestSnapshot {
    return {
      queued: this.queue.length,
      dropped: this.dropped,
      failures: this.failures,
      retryAttempts: this.retryAttempts,
      accepting: this.accepting,
      closed: this.closed,
    };
  }

  private drop(item: LogRecord, reason: SupabaseIngestDrop['reason']): void {
    this.dropped += 1;
    try {
      this.options.onDrop?.({ reason, record: item, droppedTotal: this.dropped });
    } catch {
      // User diagnostics must never make a bounded drop fail the logger call.
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error, this.snapshot());
    } catch {
      // A telemetry diagnostic callback must not create a recursive failure.
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
      if (oldest) {
        this.drop(oldest.record, 'queue-full');
      }
    }
    this.queue.push({ record, encoded, bytes });
    return true;
  }

  private takeBatch(exit: boolean): QueuedRecord[] {
    const maximumBytes = exit
      ? this.resolved.maxExitBatchBytes
      : this.resolved.maxBatchBytes;
    const batch: QueuedRecord[] = [];
    let bytes = BATCH_ENVELOPE_BUDGET;
    while (batch.length < this.resolved.batchSize && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) {
        break;
      }
      const recordBytes = item.bytes + 1;
      if (batch.length > 0 && bytes + recordBytes > maximumBytes) {
        this.queue.prepend([item]);
        break;
      }
      batch.push(item);
      bytes += recordBytes;
    }
    return batch;
  }

  private scheduleInterval(): void {
    if (
      !this.accepting ||
      this.intervalTimer ||
      this.retryTimer ||
      this.queue.length === 0
    ) {
      return;
    }
    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = null;
      void this.flush().catch(() => undefined);
    }, this.resolved.flushIntervalMillis);
    timerUnref(this.intervalTimer);
  }

  private randomUnit(): number {
    try {
      const value = this.options.random?.() ?? Math.random();
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
    } catch {
      return 0.5;
    }
  }

  private scheduleRetry(): void {
    if (!this.accepting || this.retryTimer || this.queue.length === 0) {
      return;
    }
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    const exponential = Math.min(
      this.resolved.retryMaxMillis,
      this.resolved.retryBaseMillis * 2 ** Math.min(this.retryAttempts, 20),
    );
    const jitter = exponential * (0.8 + this.randomUnit() * 0.4);
    this.retryAttempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush().catch(() => undefined);
    }, jitter);
    timerUnref(this.retryTimer);
  }

  async write(record: LogRecord): Promise<void> {
    if (!this.enqueue(record)) {
      return;
    }
    if (this.queue.length >= this.resolved.batchSize || this.options.awaitDelivery === true) {
      const delivery = this.flush();
      if (this.options.awaitDelivery === true) {
        await delivery;
      } else {
        void delivery.catch(() => undefined);
      }
    } else {
      this.scheduleInterval();
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

  private batchBody(records: readonly QueuedRecord[], batchId: string, sentAt: string): string {
    return `{"schema":${JSON.stringify(BATCH_SCHEMA)},"batchId":${JSON.stringify(batchId)},` +
      `"sentAt":${JSON.stringify(sentAt)},"records":[${records.map((item) => item.encoded).join(',')}]}`;
  }

  private async post(
    records: readonly QueuedRecord[],
    keepaliveBudget?: number,
  ): Promise<void> {
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== 'function') {
      throw new Error('No fetch implementation is available for SupabaseIngestTransport');
    }
    const token = assertClientToken(
      await resolveToken(this.options.accessToken),
      this.options.allowUnauthenticated === true,
    );
    const batchId = hashBatch(records);
    const body = this.batchBody(records, batchId, this.now().toISOString());
    const keepalive = keepaliveBudget !== undefined && byteLength(body) <= keepaliveBudget;
    const controller = new AbortController();
    const timeout = this.resolved.timeoutMillis > 0
      ? setTimeout(() => controller.abort(), this.resolved.timeoutMillis)
      : undefined;
    try {
      const response = await fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.publishableKey,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'x-client-info': '@oresoftware/next-loggers',
        },
        body,
        signal: controller.signal,
        keepalive,
        credentials: 'omit',
        redirect: 'error',
      });
      if (!response.ok) {
        const requestId = response.headers.get('x-request-id');
        throw new Error(
          `Supabase telemetry ingest returned ${response.status} ${response.statusText}` +
            (requestId ? ` (request ${requestId})` : ''),
        );
      }
      // Deliberately do not read the response body. It may contain server-side
      // diagnostics that must not be reflected into client telemetry.
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private clearTimers(): void {
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async drain(): Promise<void> {
    this.clearTimers();
    while (this.queue.length > 0) {
      const batch = this.takeBatch(false);
      if (batch.length === 0) {
        return;
      }
      try {
        await this.post(batch);
        this.retryAttempts = 0;
      } catch (error) {
        this.failures += 1;
        this.queue.prepend(batch);
        throw error;
      }
    }
  }

  flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    let failed = false;
    this.flushPromise = this.drain()
      .catch((error) => {
        failed = true;
        this.reportError(error);
        if (this.accepting) {
          this.scheduleRetry();
        }
        throw error;
      })
      .finally(() => {
        this.flushPromise = null;
        if (!failed && this.queue.length > 0 && this.accepting) {
          this.scheduleInterval();
        }
      });
    return this.flushPromise;
  }

  async flushOnExit(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    if (this.flushPromise) {
      try {
        await this.flushPromise;
      } catch {
        // drain() restored the failed batch; retry below with an exit budget.
      }
    }
    while (this.queue.length > 0) {
      const batch = this.takeBatch(true);
      if (batch.length === 0) {
        return;
      }
      try {
        await this.post(batch, this.resolved.maxExitBatchBytes);
        this.retryAttempts = 0;
      } catch (error) {
        this.failures += 1;
        this.queue.prepend(batch);
        this.reportError(error);
        throw error;
      }
    }
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = this.performClose().finally(() => {
      if (!this.closed) {
        this.closePromise = null;
      }
    });
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.accepting = false;
    this.clearTimers();
    await this.flushOnExit();
    this.closed = true;
  }
}

export function createSupabaseIngestTransport(
  options: SupabaseIngestOptions,
): SupabaseIngestTransport {
  return new SupabaseIngestTransport(options);
}
