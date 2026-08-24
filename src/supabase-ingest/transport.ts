import type { LogRecord, LogTransport } from '../base-logger.js';
import type {
  SupabaseIngestAcknowledgement,
  SupabaseIngestDrop,
  SupabaseIngestOptions,
  SupabaseIngestSnapshot,
} from './types.js';
import { CursorQueue } from './queue.js';
import { SupabaseIngestHttpError, SupabaseIngestProtocolError } from './errors.js';
import { assertClientCredential, assertClientToken, functionUrl } from './security.js';
import {
  byteLength,
  generateBatchId,
  isRetryableError,
  isRetryableStatus,
  parseAcknowledgement,
  parseRetryAfter,
  resolveToken,
  timerUnref,
} from './protocol.js';
import type { PendingBatch } from './protocol.js';

export class SupabaseIngestTransport implements LogTransport {
  readonly name = 'supabase-ingest';
  readonly options: Readonly<SupabaseIngestOptions>;
  readonly endpoint: string;

  private readonly queue = new CursorQueue<LogRecord>();
  private readonly publishableKey: string;
  private pendingBatch: PendingBatch | null = null;
  private flushPromise: Promise<void> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempts = 0;
  private acknowledged = 0;
  private rejected = 0;
  private dropped = 0;
  private failures = 0;
  private retries = 0;
  private accepting = true;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: SupabaseIngestOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('SupabaseIngestTransport requires options');
    }
    this.publishableKey = assertClientCredential(options.publishableKey, 'a publishable key');
    this.options = options;
    this.endpoint = functionUrl(options);
  }

  snapshot(): SupabaseIngestSnapshot {
    return {
      queued: this.queue.length,
      inFlight: this.pendingBatch?.records.length ?? 0,
      acknowledged: this.acknowledged,
      rejected: this.rejected,
      dropped: this.dropped,
      failures: this.failures,
      retryAttempts: this.retryAttempts,
      retries: this.retries,
      accepting: this.accepting,
      closed: this.closed,
    };
  }

  private hasData(): boolean {
    return this.pendingBatch !== null || this.queue.length > 0;
  }

  private drop(record: LogRecord, reason: SupabaseIngestDrop['reason']): void {
    this.dropped += 1;
    try {
      this.options.onDrop?.({ reason, record, droppedTotal: this.dropped });
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
    if (byteLength(encoded) > Math.max(1, this.options.maxRecordBytes ?? 128 * 1_024)) {
      this.drop(record, 'record-too-large');
      return false;
    }
    const maximum = Math.max(1, this.options.maxQueueSize ?? 2_000);
    if (this.queue.length >= maximum) {
      const oldest = this.queue.shift();
      if (oldest) {
        this.drop(oldest, 'queue-full');
      }
    }
    this.queue.push(record);
    return true;
  }

  private createBatch(exit: boolean): PendingBatch | null {
    if (this.pendingBatch) {
      return this.pendingBatch;
    }
    const maximumRecords = Math.max(1, this.options.batchSize ?? 50);
    const maximumBytes = Math.max(
      1_024,
      exit
        ? (this.options.maxExitBatchBytes ?? 60 * 1_024)
        : (this.options.maxBatchBytes ?? 480 * 1_024),
    );
    const records: LogRecord[] = [];
    let bytes = 256;
    while (records.length < maximumRecords && this.queue.length > 0) {
      const record = this.queue.shift();
      if (!record) {
        break;
      }
      const recordBytes = byteLength(JSON.stringify(record)) + 1;
      if (records.length > 0 && bytes + recordBytes > maximumBytes) {
        this.queue.prepend([record]);
        break;
      }
      records.push(record);
      bytes += recordBytes;
    }
    if (records.length === 0) {
      return null;
    }
    const batchId = String((this.options.batchIdFactory ?? generateBatchId)() || '').trim();
    if (!batchId) {
      this.queue.prepend(records);
      throw new Error('Supabase telemetry batchIdFactory returned an empty identifier');
    }
    this.pendingBatch = { batchId, records };
    return this.pendingBatch;
  }

  private scheduleInterval(): void {
    if (!this.accepting || this.intervalTimer || !this.hasData() || this.pendingBatch) {
      return;
    }
    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = null;
      void this.flush().catch((error) => {
        this.reportError(error);
        if (isRetryableError(error)) this.scheduleRetry(error);
      });
    }, Math.max(10, this.options.flushIntervalMillis ?? 1_000));
    timerUnref(this.intervalTimer);
  }

  private now(): Date {
    try {
      const value = this.options.clock?.() ?? new Date();
      return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
    } catch {
      return new Date();
    }
  }

  private randomUnit(): number {
    try {
      const value = this.options.random?.() ?? Math.random();
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
    } catch {
      return 0.5;
    }
  }

  private scheduleRetry(error?: unknown): void {
    if (!this.accepting || this.retryTimer || !this.hasData()) {
      return;
    }
    const base = Math.max(10, this.options.retryBaseMillis ?? 500);
    const maximum = Math.max(base, this.options.retryMaxMillis ?? 30_000);
    const exponential = Math.min(maximum, base * 2 ** Math.min(this.retryAttempts, 20));
    const jittered = exponential * (0.8 + this.randomUnit() * 0.4);
    const serverDelay = error instanceof SupabaseIngestHttpError
      ? error.retryAfterMillis
      : undefined;
    const delay = Math.max(jittered, serverDelay ?? 0);
    this.retryAttempts += 1;
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush().catch((nextError) => {
        this.reportError(nextError);
        if (isRetryableError(nextError)) this.scheduleRetry(nextError);
      });
    }, delay);
    timerUnref(this.retryTimer);
  }

  async write(record: LogRecord): Promise<void> {
    if (!this.enqueue(record)) {
      return;
    }
    const batchSize = Math.max(1, this.options.batchSize ?? 50);
    if (this.queue.length >= batchSize || this.options.awaitDelivery === true) {
      const delivery = this.flush();
      if (this.options.awaitDelivery === true) {
        await delivery;
      } else {
        void delivery.catch((error) => {
          this.reportError(error);
          if (isRetryableError(error)) this.scheduleRetry(error);
        });
      }
    } else {
      this.scheduleInterval();
    }
  }

  private batchBody(batch: PendingBatch): string {
    return JSON.stringify({
      schema: 'next-loggers/batch/v1',
      batchId: batch.batchId,
      sentAt: this.now().toISOString(),
      records: batch.records,
    });
  }

  private async post(batch: PendingBatch, keepalive = false): Promise<SupabaseIngestAcknowledgement> {
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== 'function') {
      throw new Error('No fetch implementation is available for SupabaseIngestTransport');
    }
    const token = await resolveToken(this.options.accessToken);
    assertClientToken(token, this.options.allowUnauthenticated === true);
    const controller = new AbortController();
    const timeoutMillis = this.options.timeoutMillis ?? 10_000;
    const timeout = timeoutMillis > 0
      ? setTimeout(() => controller.abort(), timeoutMillis)
      : undefined;
    try {
      const response = await fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.publishableKey,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'x-next-loggers-schema': 'next-loggers/batch/v1',
          'x-next-loggers-batch-id': batch.batchId,
          'x-client-info': '@oresoftware/next-loggers',
        },
        body: this.batchBody(batch),
        signal: controller.signal,
        keepalive,
        credentials: 'omit',
        redirect: 'error',
      });
      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (!response.ok) {
        const retryAfterMillis = parseRetryAfter(
          response.headers.get('retry-after'),
          Math.max(0, this.options.maxRetryAfterMillis ?? 60_000),
          this.now().getTime(),
        );
        throw new SupabaseIngestHttpError({
          status: response.status,
          statusText: response.statusText,
          retryable: isRetryableStatus(response.status),
          ...(retryAfterMillis === undefined ? {} : { retryAfterMillis }),
          ...(requestId === undefined ? {} : { requestId }),
        });
      }
      const parsed = await parseAcknowledgement(
        response,
        batch,
        this.options.requireCommitAcknowledgement !== false,
      );
      return requestId === undefined ? parsed : { ...parsed, requestId };
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

  private rejectPending(error: SupabaseIngestHttpError): void {
    const batch = this.pendingBatch;
    if (!batch) return;
    this.rejected += batch.records.length;
    for (const record of batch.records) {
      this.drop(record, 'server-rejected');
    }
    try {
      this.options.onRejectedBatch?.({
        batchId: batch.batchId,
        status: error.status,
        records: batch.records,
        error,
      });
    } catch {
      // Diagnostics must never alter queue accounting.
    }
    this.pendingBatch = null;
  }

  private acknowledge(acknowledgement: SupabaseIngestAcknowledgement): void {
    const batch = this.pendingBatch;
    if (!batch || batch.batchId !== acknowledgement.batchId) {
      throw new SupabaseIngestProtocolError('Acknowledgement does not match the in-flight batch');
    }
    this.acknowledged += batch.records.length;
    this.pendingBatch = null;
    this.retryAttempts = 0;
    try {
      this.options.onAcknowledged?.(acknowledgement);
    } catch {
      // Diagnostics must never alter delivery semantics.
    }
  }

  private async drain(exit: boolean): Promise<void> {
    this.clearTimers();
    while (this.hasData()) {
      const batch = this.createBatch(exit);
      if (!batch) return;
      try {
        const acknowledgement = await this.post(batch, exit);
        this.acknowledge(acknowledgement);
      } catch (error) {
        this.failures += 1;
        if (error instanceof SupabaseIngestHttpError && !error.retryable) {
          this.rejectPending(error);
        }
        throw error;
      }
    }
  }

  flush(): Promise<void> {
    this.flushPromise ??= this.drain(false).finally(() => {
      this.flushPromise = null;
      if (this.queue.length > 0 && this.accepting && !this.pendingBatch) {
        this.scheduleInterval();
      }
    });
    return this.flushPromise;
  }

  async flushOnExit(): Promise<void> {
    if (!this.hasData()) {
      return;
    }
    if (this.flushPromise) {
      try {
        await this.flushPromise;
      } catch {
        // The in-flight batch remains stable for the keepalive attempt below.
      }
    }
    await this.drain(true);
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closePromise ??= this.performClose().finally(() => {
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
