import type { LogRecord, LogTransport } from './base-logger.js';

export interface LokiTransportOptions {
  /** Complete Loki push endpoint, normally /loki/api/v1/push. */
  endpoint: string;
  /** Static low-cardinality labels such as cluster and environment. */
  labels?: Readonly<Record<string, string>>;
  tenantId?: string;
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  batchSize?: number;
  flushIntervalMillis?: number;
  maxQueueSize?: number;
  timeoutMillis?: number;
  maxRetries?: number;
  retryBaseMillis?: number;
  /** Called when a bounded queue evicts a record. */
  onDrop?: (record: LogRecord, reason: Error) => void;
}

interface PendingRecord {
  record: LogRecord;
  resolve(): void;
  reject(error: unknown): void;
}

interface LokiStream {
  stream: Record<string, string>;
  values: Array<[string, string]>;
}

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const RESERVED_LABELS = new Set(['service_name', 'runtime', 'level']);

class NonRetryableLokiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableLokiError';
  }
}

function validateHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`Loki endpoint must be a valid URL, got: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Loki endpoint must use http(s), got: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function normalizeStaticLabels(
  labels: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(labels ?? {})) {
    if (!LABEL_NAME.test(name)) {
      throw new TypeError(`Invalid Loki label name: ${name}`);
    }
    if (RESERVED_LABELS.has(name)) {
      throw new TypeError(`Static label ${name} is a reserved Loki label`);
    }
    if (!value) {
      continue;
    }
    normalized[name] = String(value);
  }
  return normalized;
}

function toNanoseconds(timestamp: string): string {
  const milliseconds = Date.parse(timestamp);
  const finiteMilliseconds = Number.isFinite(milliseconds) ? milliseconds : Date.now();
  return (BigInt(Math.trunc(finiteMilliseconds)) * 1_000_000n).toString();
}

function streamLabels(
  record: LogRecord,
  staticLabels: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    service_name: record.appName,
    runtime: record.runtime,
    level: record.level.toLowerCase(),
    ...staticLabels,
  };
}

function streamKey(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}\u0000${value}`)
    .join('\u0001');
}

function buildPayload(
  records: readonly LogRecord[],
  labels: Readonly<Record<string, string>>,
): { streams: LokiStream[] } {
  const streams = new Map<string, LokiStream>();
  for (const record of records) {
    const recordLabels = streamLabels(record, labels);
    const key = streamKey(recordLabels);
    let stream = streams.get(key);
    if (!stream) {
      stream = { stream: recordLabels, values: [] };
      streams.set(key, stream);
    }
    // Trace IDs stay in the structured JSON body, never as indexed labels.
    stream.values.push([toNanoseconds(record.timestamp), JSON.stringify(record)]);
  }
  return { streams: Array.from(streams.values()) };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class LokiTransport implements LogTransport {
  readonly name = 'loki';
  readonly options: Readonly<LokiTransportOptions>;
  readonly endpoint: string;

  private readonly staticLabels: Readonly<Record<string, string>>;
  private queue: PendingRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: LokiTransportOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('LokiTransport requires an options object');
    }
    this.options = options;
    this.endpoint = validateHttpUrl(options.endpoint);
    this.staticLabels = normalizeStaticLabels(options.labels);
  }

  private get batchSize(): number {
    return Math.max(1, Math.floor(this.options.batchSize ?? 100));
  }

  private get maximumQueueSize(): number {
    return Math.max(this.batchSize, Math.floor(this.options.maxQueueSize ?? 2_000));
  }

  private scheduleFlush(): void {
    if (this.timer || this.closed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, Math.max(0, this.options.flushIntervalMillis ?? 1_000));
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private notifyDrop(record: LogRecord, reason: Error): void {
    try {
      this.options.onDrop?.(record, reason);
    } catch {
      // Backpressure diagnostics cannot make queue behavior nondeterministic.
    }
  }

  write(record: LogRecord): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Loki transport is closed'));
    }
    const promise = new Promise<void>((resolve, reject) => {
      if (this.queue.length >= this.maximumQueueSize) {
        const evicted = this.queue.shift();
        if (evicted) {
          const error = new Error('Loki transport queue capacity exceeded');
          evicted.reject(error);
          this.notifyDrop(evicted.record, error);
        }
      }
      this.queue.push({ record, resolve, reject });
    });
    if (this.queue.length >= this.batchSize) {
      void this.flush().catch(() => undefined);
    } else {
      this.scheduleFlush();
    }
    return promise;
  }

  private async push(records: readonly LogRecord[]): Promise<void> {
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== 'function') {
      throw new Error('No fetch implementation is available for LokiTransport');
    }
    const body = JSON.stringify(buildPayload(records, this.staticLabels));
    const maximumRetries = Math.max(0, Math.floor(this.options.maxRetries ?? 3));
    let lastError: unknown;
    for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
      const controller = new AbortController();
      const timeoutMillis = this.options.timeoutMillis ?? 10_000;
      const timeout = timeoutMillis > 0
        ? setTimeout(() => controller.abort(), timeoutMillis)
        : undefined;
      try {
        const response = await fetchImplementation(this.endpoint, {
          method: 'POST',
          headers: {
            ...this.options.headers,
            'content-type': 'application/json',
            ...(this.options.tenantId ? { 'X-Scope-OrgID': this.options.tenantId } : {}),
          },
          body,
          signal: controller.signal,
          redirect: 'follow',
          keepalive: false,
        });
        if (!response.ok) {
          const retryable =
            response.status === 408 || response.status === 429 || response.status >= 500;
          const message = `Loki returned ${response.status} ${response.statusText}`;
          if (!retryable) {
            throw new NonRetryableLokiError(message);
          }
          throw new Error(message);
        }
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof NonRetryableLokiError || attempt >= maximumRetries) {
          break;
        }
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
      const base = Math.max(1, this.options.retryBaseMillis ?? 250);
      const delay = Math.min(base * 2 ** attempt, 5_000);
      await sleep(delay);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) {
      return Promise.resolve();
    }
    const pending = this.queue.splice(0, this.batchSize);
    this.flushPromise = this.push(pending.map(({ record }) => record))
      .then(() => {
        for (const item of pending) {
          item.resolve();
        }
      })
      .catch((error: unknown) => {
        for (const item of pending) {
          item.reject(error);
        }
        throw error;
      })
      .finally(() => {
        this.flushPromise = null;
        if (this.queue.length > 0) {
          void this.flush().catch(() => undefined);
        }
      });
    return this.flushPromise;
  }

  async flushOnExit(): Promise<void> {
    while (this.queue.length > 0 || this.flushPromise) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.flushOnExit();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export function createLokiTransport(options: LokiTransportOptions): LokiTransport {
  return new LokiTransport(options);
}
