export const LOG_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogArgument = unknown;
export type LogFields = Record<string, unknown>;
export type BuiltInLoggerRuntime =
  | 'base'
  | 'browser'
  | 'edge'
  | 'cloudflare'
  | 'node'
  | 'bun'
  | 'deno';
export type LoggerRuntime = BuiltInLoggerRuntime | (string & Record<never, never>);

export interface LogUser extends LogFields {
  id?: string;
  email?: string;
  ddUserId?: string;
  clerkUserId?: string;
  supabaseAuthUserId?: string;
  firstName?: string;
  lastName?: string;
}

export type SerializedValue =
  | null
  | boolean
  | number
  | string
  | SerializedValue[]
  | { [key: string]: SerializedValue };

export interface LogRecord {
  schema: 'next-loggers/v1';
  id: string;
  timestamp: string;
  level: LogLevel;
  runtime: LoggerRuntime;
  appName: string;
  name?: string;
  message: string;
  values: SerializedValue[];
  fields: Record<string, SerializedValue>;
  loggedInUser?: Record<string, SerializedValue>;
  users?: Array<Record<string, SerializedValue>>;
  traceId?: string;
  traceIds?: string[];
  routineId?: string;
  tags?: string[];
  context?: SerializedValue[];
  meta?: SerializedValue[];
  errors?: SerializedValue[];
  stackTrace?: string[];
}

export interface LogTransport {
  readonly name?: string;
  /** Marks an explicit OpenTelemetry sink for per-event routing. */
  readonly otel?: boolean;
  write(record: LogRecord): void | Promise<void>;
  flush?(): void | Promise<void>;
  flushOnExit?(records: readonly LogRecord[]): void | Promise<void>;
  close?(): void | Promise<void>;
}

function isOpenTelemetryTransport(transport: LogTransport): boolean {
  return (
    transport.otel === true ||
    transport.name?.trim().toLowerCase() === 'opentelemetry'
  );
}

export interface HttpTransportOptions {
  endpoint: string;
  /** Tried when the primary endpoint fails (e.g. a Google Apps Script backup collector). */
  fallbackEndpoint?: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  timeoutMillis?: number;
  fetch?: typeof fetch;
  mapBody?: (record: LogRecord) => BodyInit;
  keepalive?: boolean;
  sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface SupabaseRealtimeOptions {
  /** A Supabase project URL or a complete Realtime WebSocket URL. */
  url: string;
  /** The publishable/anon key used to connect to Supabase Realtime. */
  anonKey: string;
  /** A user JWT. When omitted, the anon key is used as the access token. */
  accessToken?: string;
  channel?: string;
  event?: string;
  maxQueueSize?: number;
  connectTimeoutMillis?: number;
  heartbeatMillis?: number;
  reconnect?: boolean;
  webSocketFactory?: WebSocketFactory;
}

/**
 * Ambient request/task context merged into every record at serialization time.
 * Typically produced by AsyncLocalStorage via `@oresoftware/next-loggers/context`,
 * but any provider (Angular zones, a framework request object, a plain closure)
 * can supply one.
 */
export interface LogContext {
  loggedInUser?: LogUser;
  users?: LogUser[];
  fields?: LogFields;
  traceId?: string;
  traceIds?: string[];
  routineId?: string;
  tags?: string[];
}

export type LogContextProvider = () => LogContext | null | undefined;

/**
 * Structural contract for Node/Bun/Deno AsyncLocalStorage (and lookalikes such
 * as zone-backed stores): only getStore() is required, so any implementation
 * can be attached without this package importing node:async_hooks itself.
 */
export interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
}

let globalLogContextProvider: LogContextProvider | null = null;

/** Registers a process-wide context provider; returns the previous one so callers can restore it. */
export function setLogContextProvider(
  provider: LogContextProvider | null,
): LogContextProvider | null {
  const previous = globalLogContextProvider;
  globalLogContextProvider = provider;
  return previous;
}

export function getLogContextProvider(): LogContextProvider | null {
  return globalLogContextProvider;
}

/** Destination for high-severity records, posted via HTTP independently of other transports. */
export interface ErrorTrackingOptions {
  url: string;
  /** Tried when the priority url fails. */
  fallbackUrl?: string;
  /** Lowest level forwarded to the error tracker; defaults to ERROR. */
  minLevel?: LogLevel | Lowercase<LogLevel>;
  /**
   * Skip re-posting records with an identical level/runtime/message/trace hash
   * (default true, mirroring the original dd loggers). A failed send releases
   * the hash so the next occurrence retries.
   */
  dedupe?: boolean;
  method?: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  timeoutMillis?: number;
  keepalive?: boolean;
  fetch?: typeof fetch;
  sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}

export interface LoggerOptions {
  appName?: string;
  name?: string;
  maxLevel?: LogLevel | Lowercase<LogLevel>;
  fields?: LogFields;
  loggedInUser?: LogUser;
  console?: boolean;
  autoSend?: boolean;
  /** Default OpenTelemetry routing policy for events from this logger. Default true. */
  otel?: boolean;
  transports?: LogTransport | LogTransport[];
  http?: HttpTransportOptions;
  supabase?: SupabaseRealtimeOptions;
  errorTracking?: ErrorTrackingOptions;
  onTransportError?: (error: unknown, transport: LogTransport, record: LogRecord) => void;
  /** Per-logger context source; overrides the provider set via setLogContextProvider. */
  contextProvider?: LogContextProvider;
  /**
   * Key substrings replaced with '[REDACTED]' in values/fields/context/meta/errors.
   * Defaults to DEFAULT_REDACTED_KEY_PATTERNS; pass false to disable entirely.
   * loggedInUser/users identity blocks are never redacted.
   */
  redactKeys?: readonly string[] | false;
  /**
   * Caps on serialized size (string length, depth, collection and property
   * counts). Defaults to DEFAULT_SERIALIZE_LIMITS; a single oversized payload
   * should never be able to take down the process it is describing.
   */
  limits?: SerializeLimits;
  /** Attach delivery to a request lifecycle, such as an Edge execution context. */
  waitUntil?: (promise: Promise<void>) => void;
  /** Attach delivery to Next.js `after()`, without importing Next.js into this package. */
  after?: (callback: () => Promise<void>) => void;
  onLifecycleError?: (error: unknown, hook: 'waitUntil' | 'after') => void;
  clock?: () => Date;
  idFactory?: () => string;
}

export interface FlushOptions {
  timeoutMillis?: number;
  sendUnsent?: boolean;
  /** Reject on a transport failure or timeout instead of the default fail-open drain. */
  throwOnError?: boolean;
}

/** All in-flight writes, shared across logger instances like a small dd-proms registry. */
export const pendingLogPromises = new Set<Promise<void>>();

export function getPendingLogCount(): number {
  return pendingLogPromises.size;
}

async function waitWithTimeout(
  promise: Promise<void>,
  timeoutMillis?: number,
  throwOnTimeout = false,
): Promise<void> {
  if (!timeoutMillis) {
    await promise;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          if (throwOnTimeout) {
            reject(new Error(`next-loggers flush exceeded ${timeoutMillis}ms`));
          } else {
            resolve();
          }
        }, timeoutMillis);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function waitForPendingLogs(options: FlushOptions = {}): Promise<void> {
  const settle = Promise.allSettled(Array.from(pendingLogPromises)).then(() => undefined);
  await waitWithTimeout(settle, options.timeoutMillis);
}

const CONSOLE_METHODS: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  TRACE: 'debug',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'error',
};

const LEVEL_INDEX = new Map<LogLevel, number>(LOG_LEVELS.map((level, index) => [level, index]));

function normalizeLevel(level: LogLevel | Lowercase<LogLevel> | undefined): LogLevel {
  const normalized = String(level || 'INFO').toUpperCase() as LogLevel;
  return LEVEL_INDEX.has(normalized) ? normalized : 'INFO';
}

function randomId(): string {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoObject?.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Key substrings redacted from values/fields/context/meta by default, carried
 * over from the original dd-next-1 logger-5 redaction list. Identity blocks
 * (loggedInUser/users) are exempt so user correlation keeps working.
 */
export const DEFAULT_REDACTED_KEY_PATTERNS: readonly string[] = [
  'password',
  'authtoken',
  'ssn',
  'bankaccount',
  'email',
  'phone',
  'token',
  'secret',
];

type RedactPatterns = readonly string[] | null;

/**
 * Caps applied while serializing. Without them a single log call carrying a
 * multi-megabyte buffer, a 100k-element array, or a deeply self-referential
 * graph can exhaust memory, blow the stack, or throw "Invalid string length"
 * inside JSON.stringify — killing the process it was meant to diagnose.
 */
export interface SerializeLimits {
  /** Strings longer than this are truncated with a marker. Default 20000. */
  maxStringLength?: number;
  /** Nesting beyond this is replaced with a marker. Default 12. */
  maxDepth?: number;
  /** Array/Set/Map entries kept per collection. Default 1000. */
  maxArrayLength?: number;
  /** Own properties kept per object. Default 200. */
  maxProperties?: number;
}

type ResolvedLimits = Required<SerializeLimits>;

export const DEFAULT_SERIALIZE_LIMITS: ResolvedLimits = {
  maxStringLength: 20_000,
  maxDepth: 12,
  maxArrayLength: 1_000,
  maxProperties: 200,
};

function resolveLimits(limits?: SerializeLimits): ResolvedLimits {
  return limits ? { ...DEFAULT_SERIALIZE_LIMITS, ...limits } : DEFAULT_SERIALIZE_LIMITS;
}

/** Appends a marker element when a collection was cut short, so truncation is visible. */
function capCollection(
  serialized: SerializedValue[],
  total: number,
  limit: number,
): SerializedValue[] {
  if (total > limit) {
    serialized.push(`[+${total - limit} more of ${total}]`);
  }
  return serialized;
}

function truncateString(value: string, limit: number): string {
  if (limit <= 0 || value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]`;
}

function shouldRedact(key: string, patterns: RedactPatterns): boolean {
  if (!patterns) {
    return false;
  }
  const lower = key.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

function serializeError(
  error: Error,
  seen: WeakSet<object>,
  redact: RedactPatterns,
  limits: ResolvedLimits,
  depth: number,
): Record<string, SerializedValue> {
  const result: Record<string, SerializedValue> = {
    name: error.name,
    message: truncateString(error.message, limits.maxStringLength),
  };
  if (error.stack) {
    result.stack = truncateString(error.stack, limits.maxStringLength);
  }
  const errorWithCause = error as Error & { cause?: unknown };
  if (errorWithCause.cause !== undefined) {
    result.cause = serialize(errorWithCause.cause, seen, redact, limits, depth + 1);
  }
  for (const key of Object.keys(error)) {
    if (shouldRedact(key, redact)) {
      result[key] = '[REDACTED]';
      continue;
    }
    result[key] = serialize(
      (error as unknown as Record<string, unknown>)[key],
      seen,
      redact,
      limits,
      depth + 1,
    );
  }
  return result;
}

function serialize(
  value: unknown,
  seen: WeakSet<object>,
  redact: RedactPatterns = null,
  limits: ResolvedLimits = DEFAULT_SERIALIZE_LIMITS,
  depth = 0,
): SerializedValue {
  if (typeof value === 'string') {
    return truncateString(value, limits.maxStringLength);
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'undefined') {
    return '[undefined]';
  }
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return `[Function${value.name ? `: ${value.name}` : ''}]`;
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }

  // Depth is checked after the cycle guard so a self-reference still reports
  // '[Circular]' (the more useful diagnosis) rather than a depth marker.
  if (depth >= limits.maxDepth) {
    return `[Max depth ${limits.maxDepth} exceeded]`;
  }

  seen.add(value);
  try {
    if (value instanceof Error) {
      return serializeError(value, seen, redact, limits, depth);
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    }
    if (value instanceof RegExp) {
      return value.toString();
    }
    if (Array.isArray(value)) {
      return capCollection(
        value.slice(0, limits.maxArrayLength).map((item) =>
          serialize(item, seen, redact, limits, depth + 1),
        ),
        value.length,
        limits.maxArrayLength,
      );
    }
    if (value instanceof Map) {
      const entries = Array.from(value.entries());
      return capCollection(
        entries.slice(0, limits.maxArrayLength).map(([key, entryValue]) => [
          serialize(key, seen, redact, limits, depth + 1),
          shouldRedact(String(key), redact)
            ? '[REDACTED]'
            : serialize(entryValue, seen, redact, limits, depth + 1),
        ]),
        entries.length,
        limits.maxArrayLength,
      );
    }
    if (value instanceof Set) {
      const entries = Array.from(value);
      return capCollection(
        entries.slice(0, limits.maxArrayLength).map((entryValue) =>
          serialize(entryValue, seen, redact, limits, depth + 1),
        ),
        entries.length,
        limits.maxArrayLength,
      );
    }

    const result: Record<string, SerializedValue> = {};
    // Object.keys plus guarded access (not Object.entries) so one throwing
    // getter poisons only its own property, not every sibling.
    const keys = Object.keys(value as Record<string, unknown>);
    for (const key of keys.slice(0, limits.maxProperties)) {
      if (shouldRedact(key, redact)) {
        result[key] = '[REDACTED]';
        continue;
      }
      try {
        result[key] = serialize(
          (value as Record<string, unknown>)[key],
          seen,
          redact,
          limits,
          depth + 1,
        );
      } catch (error) {
        result[key] = `[Unserializable: ${error instanceof Error ? error.message : String(error)}]`;
      }
    }
    if (keys.length > limits.maxProperties) {
      result.__truncatedKeys = keys.length - limits.maxProperties;
    }
    const constructorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (constructorName && constructorName !== 'Object') {
      result.__type = constructorName;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function serializeLogValue(value: unknown, limits?: SerializeLimits): SerializedValue {
  return serialize(value, new WeakSet<object>(), null, resolveLimits(limits));
}

/** serializeLogValue plus '[REDACTED]' for keys matching the given substrings. */
export function serializeLogValueRedacted(
  value: unknown,
  redactKeyPatterns: readonly string[] = DEFAULT_REDACTED_KEY_PATTERNS,
  limits?: SerializeLimits,
): SerializedValue {
  return serialize(
    value,
    new WeakSet<object>(),
    redactKeyPatterns.map((p) => p.toLowerCase()),
    resolveLimits(limits),
  );
}

function toMessagePart(value: unknown, serializer: (value: unknown) => SerializedValue): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'symbol'
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(serializer(value));
  } catch {
    return String(value);
  }
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `log-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  } else if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new TypeError(`Supabase Realtime requires an http(s) or ws(s) URL, got ${parsed.protocol}`);
  }
  if (!parsed.pathname.endsWith('/websocket')) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/realtime/v1/websocket`;
  }
  return parsed.toString();
}

export class HttpTransport implements LogTransport {
  readonly name = 'http';
  readonly options: Readonly<HttpTransportOptions>;

  constructor(options: HttpTransportOptions) {
    this.options = options;
  }

  private get endpoints(): string[] {
    return this.options.fallbackEndpoint
      ? [this.options.endpoint, this.options.fallbackEndpoint]
      : [this.options.endpoint];
  }

  private async post(endpoint: string, record: LogRecord): Promise<void> {
    const fetchImplementation = this.options.fetch || globalThis.fetch;
    if (typeof fetchImplementation !== 'function') {
      throw new Error('No fetch implementation is available for HttpTransport');
    }

    const controller = new AbortController();
    // A timeout of 0 (or negative) disables the abort timer rather than aborting instantly.
    const timeoutMillis = this.options.timeoutMillis ?? 15_000;
    const timeout = timeoutMillis > 0 ? setTimeout(() => controller.abort(), timeoutMillis) : undefined;
    try {
      const response = await fetchImplementation(endpoint, {
        method: this.options.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.options.headers,
        },
        body: this.options.mapBody?.(record) ?? JSON.stringify(record),
        signal: controller.signal,
        redirect: 'follow',
        keepalive: this.options.keepalive ?? true,
      });
      if (!response.ok) {
        throw new Error(`Log endpoint returned ${response.status} ${response.statusText}`);
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async write(record: LogRecord): Promise<void> {
    let lastError: unknown;
    for (const endpoint of this.endpoints) {
      try {
        await this.post(endpoint, record);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  flushOnExit(records: readonly LogRecord[]): void {
    const beacon =
      this.options.sendBeacon ||
      (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? navigator.sendBeacon.bind(navigator)
        : undefined);
    if (!beacon) {
      return;
    }
    for (const record of records) {
      const body = this.options.mapBody?.(record) ?? JSON.stringify(record);
      for (const endpoint of this.endpoints) {
        try {
          if (beacon(endpoint, body)) {
            break;
          }
        } catch {
          // The original keepalive fetch remains the fallback.
        }
      }
    }
  }
}

function createErrorTrackingTransport(tracking: ErrorTrackingOptions): LogTransport {
  const inner = new HttpTransport({
    endpoint: tracking.url,
    ...(tracking.fallbackUrl ? { fallbackEndpoint: tracking.fallbackUrl } : {}),
    ...(tracking.method ? { method: tracking.method } : {}),
    ...(tracking.headers ? { headers: tracking.headers } : {}),
    ...(tracking.timeoutMillis !== undefined ? { timeoutMillis: tracking.timeoutMillis } : {}),
    ...(tracking.keepalive !== undefined ? { keepalive: tracking.keepalive } : {}),
    ...(tracking.fetch ? { fetch: tracking.fetch } : {}),
    ...(tracking.sendBeacon ? { sendBeacon: tracking.sendBeacon } : {}),
  });
  const threshold = LEVEL_INDEX.get(normalizeLevel(tracking.minLevel ?? 'ERROR')) ?? 4;
  const matches = (record: LogRecord): boolean =>
    (LEVEL_INDEX.get(record.level) ?? 0) >= threshold;

  const seenHashes = tracking.dedupe === false ? null : new Set<string>();
  const MAX_HASHES = 5_000;
  const hashOf = (record: LogRecord): string =>
    hashString(JSON.stringify([record.level, record.runtime, record.message, record.traceIds ?? []]));

  return {
    name: 'error-tracking',
    async write(record) {
      if (!matches(record)) {
        return;
      }
      if (!seenHashes) {
        await inner.write(record);
        return;
      }
      const hash = hashOf(record);
      if (seenHashes.has(hash)) {
        return;
      }
      if (seenHashes.size >= MAX_HASHES) {
        // Evict the oldest half (Sets iterate in insertion order).
        let index = 0;
        for (const existing of seenHashes) {
          if (index >= MAX_HASHES / 2) {
            break;
          }
          seenHashes.delete(existing);
          index += 1;
        }
      }
      seenHashes.add(hash);
      try {
        await inner.write(record);
      } catch (error) {
        seenHashes.delete(hash);
        throw error;
      }
    },
    flushOnExit: (records) => inner.flushOnExit(records.filter(matches)),
  };
}

function assertHttpUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`${label} must be a valid URL, got: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label} must use http(s), got: ${parsed.protocol}`);
  }
}

type PhoenixMessage = {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: string;
  join_ref?: string;
};

export class SupabaseRealtimeTransport implements LogTransport {
  readonly name = 'supabase-realtime';
  readonly options: Readonly<SupabaseRealtimeOptions>;

  private socket: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private queue: PhoenixMessage[] = [];
  private joined = false;
  private joinRef = '';
  private closed = false;
  private ref = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  constructor(options: SupabaseRealtimeOptions) {
    this.options = options;
  }

  private nextRef(): string {
    this.ref += 1;
    return String(this.ref);
  }

  private get topic(): string {
    return `realtime:${this.options.channel || 'next-loggers'}`;
  }

  private createSocket(): WebSocketLike {
    const factory = this.options.webSocketFactory || ((url: string) => {
      const WebSocketConstructor = (globalThis as { WebSocket?: new (value: string) => WebSocketLike })
        .WebSocket;
      if (!WebSocketConstructor) {
        throw new Error(
          'No WebSocket implementation is available. Pass supabase.webSocketFactory in this runtime.',
        );
      }
      return new WebSocketConstructor(url);
    });

    const url = new URL(normalizeUrl(this.options.url));
    url.searchParams.set('apikey', this.options.anonKey);
    url.searchParams.set('vsn', '1.0.0');
    return factory(url.toString());
  }

  private sendRaw(message: PhoenixMessage): void {
    if (!this.socket || this.socket.readyState !== 1 || !this.joined) {
      throw new Error('Supabase Realtime channel is not connected');
    }
    this.socket.send(JSON.stringify(message));
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === 1) {
        this.socket.send(
          JSON.stringify({
            topic: 'phoenix',
            event: 'heartbeat',
            payload: {},
            ref: this.nextRef(),
          }),
        );
      }
    }, this.options.heartbeatMillis ?? 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private enqueue(message: PhoenixMessage): void {
    const maximum = Math.max(1, this.options.maxQueueSize ?? 500);
    if (this.queue.length >= maximum) {
      this.queue.shift();
    }
    this.queue.push(message);
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.socket?.readyState === 1 && this.joined) {
      const message = this.queue.shift();
      if (!message) {
        return;
      }
      try {
        message.join_ref = this.joinRef;
        this.sendRaw(message);
      } catch {
        this.queue.unshift(message);
        return;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.options.reconnect === false || this.queue.length === 0) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Supabase Realtime transport is closed'));
    }
    if (this.socket?.readyState === 1 && this.joined) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    let socket: WebSocketLike;
    try {
      socket = this.createSocket();
    } catch (error) {
      return Promise.reject(error);
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      this.socket = socket;
      this.joined = false;
      this.joinRef = '';
      const timeout = setTimeout(() => finish(new Error('Supabase Realtime connection timed out')),
        this.options.connectTimeoutMillis ?? 8_000,
      );

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.connectPromise = null;
        if (error) {
          if (socket.readyState === 0 || socket.readyState === 1) {
            socket.close(1011, error.message.slice(0, 120));
          }
          reject(error);
        } else {
          resolve();
        }
      };

      socket.onopen = () => {
        const ref = this.nextRef();
        this.joinRef = ref;
        const accessToken = this.options.accessToken || this.options.anonKey;
        socket.send(
          JSON.stringify({
            topic: this.topic,
            event: 'phx_join',
            payload: {
              config: {
                broadcast: { ack: true, self: false },
                presence: { enabled: false },
                postgres_changes: [],
                private: false,
              },
              access_token: accessToken,
            },
            ref,
            join_ref: ref,
          }),
        );
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            topic?: string;
            event?: string;
            payload?: { status?: string };
          };
          if (
            message.topic === this.topic &&
            message.event === 'phx_reply' &&
            message.payload?.status === 'ok'
          ) {
            this.joined = true;
            this.reconnectAttempts = 0;
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
            }
            this.startHeartbeat();
            this.drainQueue();
            finish();
          } else if (
            message.topic === this.topic &&
            message.event === 'phx_reply' &&
            message.payload?.status === 'error' &&
            !this.joined
          ) {
            finish(new Error('Supabase Realtime rejected the channel join'));
          } else if (
            message.topic === this.topic &&
            (message.event === 'phx_error' || message.event === 'phx_close')
          ) {
            socket.close(1011, `Supabase Realtime sent ${message.event}`);
          }
        } catch {
          // Ignore messages not owned by this transport.
        }
      };

      socket.onerror = () => finish(new Error('Supabase Realtime WebSocket error'));
      socket.onclose = () => {
        this.joined = false;
        this.joinRef = '';
        this.stopHeartbeat();
        if (!settled) {
          finish(new Error('Supabase Realtime WebSocket closed before joining'));
        }
        this.scheduleReconnect();
      };
    });

    return this.connectPromise;
  }

  async write(record: LogRecord): Promise<void> {
    const ref = this.nextRef();
    const message: PhoenixMessage = {
      topic: this.topic,
      event: 'broadcast',
      payload: {
        type: 'broadcast',
        event: this.options.event || 'log',
        payload: record,
      },
      ref,
      join_ref: this.joinRef,
    };

    try {
      await this.connect();
      message.join_ref = this.joinRef;
      this.sendRaw(message);
    } catch (error) {
      this.enqueue(message);
      this.scheduleReconnect();
      throw error;
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    await this.connect();
    this.drainQueue();
    if (this.queue.length > 0) {
      throw new Error(`${this.queue.length} Supabase Realtime log messages remain queued`);
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, 'next-loggers transport closed');
    this.socket = null;
    this.joined = false;
    this.joinRef = '';
    this.reconnectAttempts = 0;
  }
}

export class LogEvent {
  readonly logger: BaseLogger;
  readonly level: LogLevel;
  readonly values: LogArgument[];

  protected fields: LogFields = {};
  protected loggedInUser: LogUser = {};
  protected users: LogUser[] = [];
  protected traceId = '';
  protected traceIds = new Set<string>();
  protected routineId = '';
  protected tags = new Set<string>();
  protected context: LogArgument[] = [];
  protected meta: LogArgument[] = [];
  protected stackTrace: string[] = [];
  protected sendPromise: Promise<void> | null = null;
  protected record: LogRecord | null = null;
  protected otelEnabled: boolean | undefined;

  constructor(logger: BaseLogger, level: LogLevel, values: LogArgument[]) {
    this.logger = logger;
    this.level = level;
    this.values = values;
  }

  addFields(fields: LogFields): this {
    Object.assign(this.fields, fields);
    return this;
  }

  /** Explicitly route this event to configured OTEL transports. */
  useOtel(): this {
    return this.withOtel(true);
  }

  /** Keep normal logging sinks while skipping OTEL transports for this event. */
  notOtel(): this {
    return this.withOtel(false);
  }

  withOtel(enabled: boolean): this {
    this.otelEnabled = enabled;
    return this;
  }

  /** Restore the logger-level OTEL routing default. */
  resetOtel(): this {
    this.otelEnabled = undefined;
    return this;
  }

  isOtelEnabled(fallback = true): boolean {
    return this.otelEnabled ?? fallback;
  }

  addTrace(id: string, options?: { makeFirst?: boolean }): this {
    const value = String(id || '').trim();
    if (!value) {
      return this;
    }
    if (!this.traceId || options?.makeFirst) {
      this.traceId = value;
    }
    this.traceIds.add(value);
    return this;
  }

  addTraceId(id: string, options?: { makeFirst?: boolean }): this {
    return this.addTrace(id, options);
  }

  addRoutineId(id: string): this {
    this.routineId = String(id || '');
    return this;
  }

  addTags(...tags: string[]): this {
    for (const tag of tags) {
      const value = String(tag || '').trim();
      if (value) {
        this.tags.add(value);
      }
    }
    return this;
  }

  addTagList(tags: string[]): this {
    return this.addTags(...tags);
  }

  addContext(value: LogArgument): this {
    this.context.push(value);
    return this;
  }

  addMeta(value: LogArgument): this {
    this.meta.push(value);
    return this;
  }

  addLoggedInUserInfo(user: LogUser): this {
    Object.assign(this.loggedInUser, user);
    return this;
  }

  addLoggedInUserId(id: string): this {
    this.loggedInUser.id = id;
    return this;
  }

  addUserInfo(user: LogUser): this {
    this.users.push(user);
    return this;
  }

  setUserContext(user: { ddUserId: string }, userInfo?: LogUser): this {
    if (userInfo) {
      this.addUserInfo(userInfo);
    }
    return this.addLoggedInUserInfo({ ...userInfo, ddUserId: user.ddUserId });
  }

  captureStackTrace(message = 'next-loggers stack trace'): this {
    const stack = new Error(message).stack;
    if (stack) {
      this.stackTrace.push(
        ...stack
          .split('\n')
          .filter((line) => line && !/node_modules[\\/](@oresoftware[\\/])?next-loggers/.test(line)),
      );
    }
    return this;
  }

  getHashCode(): string {
    return hashString(
      JSON.stringify([
        this.level,
        this.logger.runtime,
        this.values.map((value) => serializeLogValue(value)),
        Array.from(this.traceIds),
      ]),
    );
  }

  toJSON(now = this.logger.now().toISOString()): LogRecord {
    if (this.record) {
      return this.record;
    }

    const redacted = (value: unknown): SerializedValue => this.logger.serializeValue(value);
    const errors = this.values.filter((value) => value instanceof Error).map(redacted);
    // Merge precedence, lowest to highest: logger state < ambient context < event-level calls.
    const context = this.logger.getContext();
    const loggedInUser = {
      ...this.logger.getCurrentUser(),
      ...context?.loggedInUser,
      ...this.loggedInUser,
    };
    const users = [...(context?.users ?? []), ...this.users];
    const traceId = this.traceId || context?.traceId || '';
    const traces = Array.from(
      new Set([
        ...this.traceIds,
        ...(context?.traceId ? [context.traceId] : []),
        ...(context?.traceIds ?? []),
      ]),
    );
    const routineId = this.routineId || context?.routineId || '';
    const tags = Array.from(new Set([...this.tags, ...(context?.tags ?? [])]));
    const fields = {
      ...this.logger.fields,
      ...context?.fields,
      ...this.fields,
      ...this.logger.getRuntimeFields(),
    };
    this.record = {
      schema: 'next-loggers/v1',
      id: this.logger.createId(),
      timestamp: now,
      level: this.level,
      runtime: this.logger.runtime,
      appName: this.logger.appName,
      ...(this.logger.name ? { name: this.logger.name } : {}),
      message: this.values.map((value) => toMessagePart(value, redacted)).join(' '),
      values: this.values.map(redacted),
      fields: redacted(fields) as Record<string, SerializedValue>,
      ...(Object.keys(loggedInUser).length > 0
        ? { loggedInUser: serializeLogValue(loggedInUser) as Record<string, SerializedValue> }
        : {}),
      ...(users.length > 0
        ? {
            users: users.map(
              (user) => serializeLogValue(user) as Record<string, SerializedValue>,
            ),
          }
        : {}),
      ...(traceId ? { traceId } : {}),
      ...(traces.length > 0 ? { traceIds: traces } : {}),
      ...(routineId ? { routineId } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(this.context.length > 0 ? { context: this.context.map(redacted) } : {}),
      ...(this.meta.length > 0 ? { meta: this.meta.map(redacted) } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      ...(this.stackTrace.length > 0 ? { stackTrace: this.stackTrace } : {}),
    };
    return this.record;
  }

  getJSON(options?: { now?: string }): string {
    return JSON.stringify(this.toJSON(options?.now));
  }

  send(store = true): Promise<void> {
    this.sendPromise ??= this.logger.emitEvent(this, store);
    return this.sendPromise;
  }
}

export class BaseLogger<TEvent extends LogEvent = LogEvent> {
  readonly runtime: LoggerRuntime;
  readonly appName: string;
  readonly name: string | undefined;
  readonly maxLevel: LogLevel;
  readonly fields: LogFields;

  protected readonly options: Readonly<LoggerOptions>;
  protected readonly transports: LogTransport[];

  protected currentUser: LogUser;
  protected pending = new Set<Promise<void>>();
  protected unsentEvents = new Set<LogEvent>();
  protected activeRecords = new Set<LogRecord>();

  constructor(options: LoggerOptions = {}, runtime: LoggerRuntime = 'base') {
    this.options = options;
    this.runtime = runtime;
    this.appName = options.appName || 'app';
    this.name = options.name;
    this.maxLevel = normalizeLevel(options.maxLevel);
    this.fields = { ...options.fields };
    this.currentUser = { ...options.loggedInUser };
    this.transports = options.transports
      ? Array.isArray(options.transports)
        ? [...options.transports]
        : [options.transports]
      : [];
    if (options.http) {
      this.transports.push(new HttpTransport(options.http));
    }
    if (options.supabase) {
      this.transports.push(new SupabaseRealtimeTransport(options.supabase));
    }
    if (options.errorTracking) {
      this.transports.push(createErrorTrackingTransport(options.errorTracking));
    }
  }

  now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  /** Serializes with this logger's redaction rules and size limits applied. */
  serializeValue(value: unknown): SerializedValue {
    const redactKeys = this.options.redactKeys ?? DEFAULT_REDACTED_KEY_PATTERNS;
    if (redactKeys === false) {
      return serializeLogValue(value, this.options.limits);
    }
    return serializeLogValueRedacted(value, redactKeys, this.options.limits);
  }

  createId(): string {
    return this.options.idFactory?.() ?? randomId();
  }

  getCurrentUser(): LogUser {
    return { ...this.currentUser };
  }

  /**
   * Attaches an AsyncLocalStorage-like store whose current frame is merged into
   * every record. Pass `select` when the store's shape is not a LogContext.
   * Written into options so anew() children inherit the attachment.
   */
  setALS<TStore = LogContext>(
    storage: AsyncLocalStorageLike<TStore>,
    select?: (store: TStore) => LogContext | null | undefined,
  ): this {
    if (!storage || typeof storage.getStore !== 'function') {
      throw new TypeError(
        'setALS(storage) requires an AsyncLocalStorage-like object exposing getStore()',
      );
    }
    if (select !== undefined && typeof select !== 'function') {
      throw new TypeError('setALS(storage, select) requires select to be a function');
    }
    return this.setContextProvider(() => {
      const store = storage.getStore();
      if (store === undefined || store === null) {
        return undefined;
      }
      return select ? select(store) : (store as unknown as LogContext);
    });
  }

  /**
   * Points high-severity records at an error-tracking endpoint (with optional
   * fallback, e.g. a Vercel route first and a Google Apps Script collector
   * second). Written into options so anew() children inherit the destination.
   */
  setErrorTracking(tracking: ErrorTrackingOptions): this {
    if (!tracking || typeof tracking !== 'object') {
      throw new TypeError('setErrorTracking requires an options object with a url');
    }
    assertHttpUrl(tracking.url, 'errorTracking.url');
    if (tracking.fallbackUrl) {
      assertHttpUrl(tracking.fallbackUrl, 'errorTracking.fallbackUrl');
    }
    (this.options as LoggerOptions).errorTracking = { ...tracking };
    const transport = createErrorTrackingTransport(tracking);
    const index = this.transports.findIndex((existing) => existing.name === 'error-tracking');
    if (index >= 0) {
      this.transports[index] = transport;
    } else {
      this.transports.push(transport);
    }
    return this;
  }

  setErrorTrackingUrl(url: string, tracking: Omit<ErrorTrackingOptions, 'url'> = {}): this {
    return this.setErrorTracking({ ...tracking, url });
  }

  setContextProvider(provider: LogContextProvider | null): this {
    if (provider !== null && typeof provider !== 'function') {
      throw new TypeError('setContextProvider requires a function or null');
    }
    // Deliberate write-through into options so every anew() implementation,
    // which spreads this.options, carries the provider to child loggers.
    const options = this.options as LoggerOptions;
    if (provider) {
      options.contextProvider = provider;
    } else {
      delete options.contextProvider;
    }
    return this;
  }

  /** Resolves ambient context from the per-logger provider, else the global one. Never throws. */
  getContext(): LogContext | undefined {
    const provider = this.options.contextProvider ?? getLogContextProvider();
    if (!provider) {
      return undefined;
    }
    try {
      const context = provider();
      return context && typeof context === 'object' ? context : undefined;
    } catch {
      return undefined;
    }
  }

  getRuntimeFields(): LogFields {
    return {};
  }

  setCurrentUser(user: LogUser): this {
    this.currentUser = { ...this.currentUser, ...user };
    return this;
  }

  addFields(fields: LogFields): this {
    Object.assign(this.fields, fields);
    return this;
  }

  addRoutineId(id: string): this {
    this.fields.routineId = id;
    return this;
  }

  getLogLevel(): LogLevel {
    return this.maxLevel;
  }

  isOtelEnabled(): boolean {
    return this.options.otel ?? true;
  }

  setOtelEnabled(enabled: boolean): this {
    (this.options as LoggerOptions).otel = enabled;
    return this;
  }

  useOtel(): this {
    return this.setOtelEnabled(true);
  }

  notOtel(): this {
    return this.setOtelEnabled(false);
  }

  /** Snapshot used by explicit decorators without exposing mutable internals. */
  getTransports(): readonly LogTransport[] {
    return [...this.transports];
  }

  anew(options: LoggerOptions = {}): BaseLogger<TEvent> {
    return new BaseLogger<TEvent>(
      {
        ...this.options,
        ...options,
        appName: options.appName || this.appName,
        fields: { ...this.fields, ...options.fields },
        loggedInUser: { ...this.currentUser, ...options.loggedInUser },
      },
      this.runtime,
    );
  }

  protected createLogEvent(level: LogLevel, values: LogArgument[]): TEvent {
    return new LogEvent(this, level, values) as TEvent;
  }

  protected createEvent(level: LogLevel, values: LogArgument[]): TEvent {
    const event = this.createLogEvent(level, values);
    this.unsentEvents.add(event);
    if (this.options.autoSend) {
      queueMicrotask(() => void event.send());
    }
    return event;
  }

  trace(...values: LogArgument[]): TEvent {
    return this.createEvent('TRACE', values);
  }

  debug(...values: LogArgument[]): TEvent {
    return this.createEvent('DEBUG', values);
  }

  info(...values: LogArgument[]): TEvent {
    return this.createEvent('INFO', values);
  }

  log(...values: LogArgument[]): TEvent {
    return this.info(...values);
  }

  warn(...values: LogArgument[]): TEvent {
    return this.createEvent('WARN', values);
  }

  error(...values: LogArgument[]): TEvent {
    return this.createEvent('ERROR', values);
  }

  fatal(...values: LogArgument[]): TEvent {
    return this.createEvent('FATAL', values);
  }

  protected isEnabled(level: LogLevel): boolean {
    return (LEVEL_INDEX.get(level) ?? 0) >= (LEVEL_INDEX.get(this.maxLevel) ?? 2);
  }

  protected writeConsole(record: LogRecord): void {
    const method = CONSOLE_METHODS[record.level];
    const prefix = `[${record.timestamp}] [${record.level}] [${record.appName}]`;
    const consoleMethod = console[method] || console.log;
    consoleMethod(prefix, ...record.values);
  }

  emitEvent(event: LogEvent, store = true): Promise<void> {
    this.unsentEvents.delete(event);
    if (!this.isEnabled(event.level)) {
      return Promise.resolve();
    }

    const record = event.toJSON();
    this.activeRecords.add(record);
    const task = (async () => {
      if (this.options.console !== false) {
        this.writeConsole(record);
      }
      if (!store) {
        return;
      }
      const results = await Promise.allSettled(
        this.transports.map(async (transport) => {
          if (
            isOpenTelemetryTransport(transport) &&
            !event.isOtelEnabled(this.isOtelEnabled())
          ) {
            return;
          }
          await transport.write(record);
        }),
      );
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result?.status === 'rejected') {
          const transport = this.transports[index];
          if (transport) {
            if (this.options.onTransportError) {
              this.options.onTransportError(result.reason, transport, record);
            } else if (this.options.console !== false) {
              console.error(`[next-loggers] ${transport.name || 'transport'} failed`, result.reason);
            }
          }
        }
      }
    })();

    this.pending.add(task);
    pendingLogPromises.add(task);
    const cleanup = (): void => {
      this.pending.delete(task);
      pendingLogPromises.delete(task);
      this.activeRecords.delete(record);
    };
    void task.then(cleanup, cleanup);
    try {
      this.options.waitUntil?.(task);
    } catch (error) {
      this.options.onLifecycleError?.(error, 'waitUntil');
    }
    try {
      this.options.after?.(async () => task);
    } catch (error) {
      this.options.onLifecycleError?.(error, 'after');
    }
    return task;
  }

  async flush(options: FlushOptions = {}): Promise<void> {
    if (options.sendUnsent) {
      await Promise.allSettled(Array.from(this.unsentEvents, async (event) => event.send()));
    }
    const settle = async (): Promise<void> => {
      const results = await Promise.allSettled([
        ...Array.from(this.pending),
        ...this.transports.map(async (transport) => transport.flush?.()),
      ]);
      if (options.throwOnError) {
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, 'next-loggers flush failed');
        }
      }
    };
    await waitWithTimeout(settle(), options.timeoutMillis, options.throwOnError === true);
  }

  async flushOnExit(options: FlushOptions = {}): Promise<void> {
    for (const event of Array.from(this.unsentEvents)) {
      void event.send();
    }
    const records = Array.from(this.activeRecords);
    const exitTasks = this.transports.map(async (transport) => transport.flushOnExit?.(records));
    const settle = Promise.allSettled([
      this.flush({ ...options, sendUnsent: true }),
      ...exitTasks,
    ]).then(() => undefined);
    await waitWithTimeout(settle, options.timeoutMillis);
  }

  async close(options: FlushOptions = {}): Promise<void> {
    await this.flushOnExit(options);
    await Promise.allSettled(this.transports.map(async (transport) => transport.close?.()));
  }
}

export function createLogger(options: LoggerOptions = {}): BaseLogger {
  return new BaseLogger(options);
}

export const logger = createLogger();

/** Verifies the packed package through r2g's phase-S downstream consumer. */
export async function r2gSmokeTest(): Promise<boolean> {
  let delivered = false;
  const smokeLogger = createLogger({
    console: false,
    transports: {
      write(record) {
        delivered = record.message === 'next-loggers r2g smoke test';
      },
    },
  });

  await smokeLogger.info('next-loggers r2g smoke test').send();
  await smokeLogger.close();
  return delivered;
}
export default logger;
