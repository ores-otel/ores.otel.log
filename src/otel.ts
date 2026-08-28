import type {
  BaseLogger,
  LogContextProvider,
  LogFields,
  LogLevel,
  LogRecord,
  LogTransport,
  LoggerOptions,
  SerializedValue,
} from './base-logger.js';

/** Reserved next-loggers/v1 fields carrying the complete W3C span tuple. */
export const OTEL_FIELD_KEYS = Object.freeze({
  spanId: 'otel.span_id',
  parentSpanId: 'otel.parent_span_id',
  traceFlags: 'otel.trace_flags',
  traceState: 'otel.trace_state',
  remote: 'otel.remote',
  scopeName: 'otel.scope.name',
  scopeVersion: 'otel.scope.version',
} as const);

/**
 * The OpenTelemetry attribute subset accepted by every current language SDK.
 * Keeping this structural avoids importing an SDK, installing a global provider,
 * or enabling automatic instrumentation in application code.
 */
export type OtelAttributeScalar = string | number | boolean;
export type OtelAttributeValue = OtelAttributeScalar | readonly OtelAttributeScalar[];
export type OtelAttributes = Record<string, OtelAttributeValue>;

export interface OtelAttributeLimits {
  /** Includes semantic and user fields. Defaults to 128. */
  maxAttributes?: number;
  /** UTF-16 code units after deterministic JSON conversion. Defaults to 4096. */
  maxAttributeValueLength?: number;
  /** Primitive array items retained per attribute. Defaults to 64. */
  maxArrayLength?: number;
  /** @deprecated Use maxAttributeValueLength. Zero preserves the legacy unbounded behavior. */
  maxAttributeLength?: number;
  /** @deprecated Use maxArrayLength. */
  maxAttributeArrayLength?: number;
}

const TRACE_ID = /^[0-9a-f]{32}$/iu;
const SPAN_ID = /^[0-9a-f]{16}$/iu;
const ZERO_TRACE_ID = /^0{32}$/u;
const ZERO_SPAN_ID = /^0{16}$/u;
const DEFAULT_ATTRIBUTE_LIMIT = 128;
const DEFAULT_VALUE_LIMIT = 4_096;
const DEFAULT_ARRAY_LIMIT = 64;
const MAX_ATTRIBUTE_NAME_LENGTH = 256;
const MAX_TRACE_STATE_LENGTH = 512;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

export function isValidTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value) && !ZERO_TRACE_ID.test(value);
}

export function isValidSpanId(value: unknown): value is string {
  return typeof value === 'string' && SPAN_ID.test(value) && !ZERO_SPAN_ID.test(value);
}

function isValidTraceFlags(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xff;
}

function boundedString(value: string, maximum = DEFAULT_VALUE_LIMIT): string {
  const limit = positiveInteger(maximum, DEFAULT_VALUE_LIMIT);
  const marker = '…[truncated]';
  const suffix = limit < marker.length ? '…' : marker;
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function normalizedLimits(limits: OtelAttributeLimits): OtelAttributeLimits {
  const legacyValue = limits.maxAttributeLength;
  const legacyArray = limits.maxAttributeArrayLength;
  const valueLimit = limits.maxAttributeValueLength ?? (
    legacyValue === 0 ? Number.MAX_SAFE_INTEGER : legacyValue
  );
  const arrayLimit = limits.maxArrayLength ?? (
    legacyArray === undefined ? undefined : Math.max(1, Math.floor(legacyArray))
  );
  return {
    ...limits,
    ...(valueLimit === undefined ? {} : { maxAttributeValueLength: valueLimit }),
    ...(arrayLimit === undefined ? {} : { maxArrayLength: arrayLimit }),
  };
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function scalar(value: SerializedValue): OtelAttributeScalar | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function attributeValue(
  value: SerializedValue | OtelAttributeValue,
  limits: OtelAttributeLimits,
): OtelAttributeValue | undefined {
  const maximum = positiveInteger(limits.maxAttributeValueLength, DEFAULT_VALUE_LIMIT);
  const direct = scalar(value as SerializedValue);
  if (typeof direct === 'string') {
    return boundedString(direct, maximum);
  }
  if (direct !== undefined) {
    return direct;
  }
  if (Array.isArray(value)) {
    const maximumItems = positiveInteger(limits.maxArrayLength, DEFAULT_ARRAY_LIMIT);
    const candidate = value.slice(0, maximumItems).map((item) => scalar(item as SerializedValue));
    if (candidate.every((item): item is OtelAttributeScalar => item !== undefined)) {
      return candidate.map((item) =>
        typeof item === 'string' ? boundedString(item, maximum) : item,
      );
    }
  }
  if (value === null) {
    return undefined;
  }
  return boundedString(stableJson(value), maximum);
}

class AttributeBuilder {
  readonly values: OtelAttributes = {};
  private count = 0;
  private readonly maximum: number;

  constructor(private readonly limits: OtelAttributeLimits) {
    this.limits = normalizedLimits(limits);
    this.maximum = positiveInteger(this.limits.maxAttributes, DEFAULT_ATTRIBUTE_LIMIT);
  }

  set(name: string, value: SerializedValue | OtelAttributeValue | undefined): void {
    if (!name || value === undefined) {
      return;
    }
    const normalizedName = boundedString(name, MAX_ATTRIBUTE_NAME_LENGTH);
    const exists = Object.prototype.hasOwnProperty.call(this.values, normalizedName);
    if (!exists && this.count >= this.maximum) {
      return;
    }
    const converted = attributeValue(value, this.limits);
    if (converted === undefined) {
      return;
    }
    if (!exists) {
      this.count += 1;
    }
    this.values[normalizedName] = converted;
  }
}

export interface OtelSpanContextLike {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string | { serialize?(): string };
  isRemote?: boolean;
}

export interface OtelSpanLike {
  spanContext(): OtelSpanContextLike;
  isRecording?(): boolean;
  addEvent(name: string, attributes?: OtelAttributes, startTime?: Date | number): void;
  recordException?(exception: Error | Record<string, unknown>, time?: Date | number): void;
  setStatus?(status: { code: number; message?: string }): unknown;
  end?(endTime?: Date | number): void;
}

export interface OtelStartSpanOptions {
  kind?: number;
  attributes?: OtelAttributes;
  startTime?: Date | number;
  root?: boolean;
}

export interface OtelTracerLike {
  startActiveSpan<T>(
    name: string,
    options: OtelStartSpanOptions,
    callback: (span: OtelSpanLike) => T,
  ): T;
}

export interface OtelLogRecordLike {
  body?: unknown;
  severityNumber?: number;
  severityText?: string;
  attributes?: OtelAttributes;
  timestamp?: Date | number;
  /** Optional context supplied by the application-owned OpenTelemetry API. */
  context?: unknown;
}

export interface OtelLoggerLike {
  emit(record: OtelLogRecordLike): void;
}

/** Bound method or adapter for an application-owned OTEL provider. */
export type OtelForceFlushCallback = () => void | Promise<void>;

export interface OpenTelemetryTransportOptions extends OtelAttributeLimits {
  /** Logger obtained by the application from its chosen OpenTelemetry SDK. */
  logger: OtelLoggerLike;
  /**
   * Bound `forceFlush` methods for application-owned logger, tracer, or meter
   * providers. The bridge never calls provider shutdown.
   */
  forceFlushCallbacks?: readonly OtelForceFlushCallback[];
  /** Explicit active-span lookup. Never imported from a global OTEL singleton. */
  activeSpan?: () => OtelSpanLike | null | undefined;
  /** Explicit context lookup passed back to the OTEL log emitter, when needed. */
  activeContext?: () => unknown;
  attributes?: OtelAttributes;
  /** Static, low-cardinality attributes used only by recordMetric. */
  metricAttributes?: OtelAttributes;
  includeFields?: boolean;
  includeValues?: boolean;
  emitSpanEvents?: boolean;
  recordExceptions?: boolean;
  /** Maximum string/JSON attribute length. Default 8192. */
  maxAttributeLength?: number;
  /** Maximum primitive array elements retained in one attribute. Default 64. */
  maxAttributeArrayLength?: number;
  /**
   * Stable attribute names allowed on metrics. High-cardinality trace IDs,
   * request fields, users and messages are excluded by default.
   */
  metricAttributeKeys?: readonly string[];
  /** Optional metrics hook backed by an application-owned OTEL meter. */
  recordMetric?: (name: string, value: number, attributes: OtelAttributes) => void;
  /** Optional diagnostic hook for bridge side effects other than logger.emit(). */
  onBridgeError?: (error: unknown, operation: string) => void;
  /** Fail open by default so optional telemetry cannot replace application behavior. */
  failOpen?: boolean;
  /** @deprecated Use onBridgeError. Retained for native/legacy bridge compatibility. */
  onError?: (error: unknown, operation: string, record: LogRecord) => void;
}

export interface OpenTelemetryContextProviderOptions {
  /** Require a recording span. Defaults to false so sampled-out traces still correlate logs. */
  requireRecordingSpan?: boolean;
  onBridgeError?: (error: unknown, operation: string) => void;
}

export interface WithOpenTelemetrySpanOptions extends OtelStartSpanOptions {
  /** Set false to suppress successful start/completion records. Default DEBUG. */
  lifecycleLevel?: Lowercase<LogLevel> | LogLevel | false;
  logFields?: LogFields;
  tags?: readonly string[];
  okStatusCode?: number;
  errorStatusCode?: number;
  /** Throw when the tracer cannot start. Default false: run with a no-op span. */
  failOnStartError?: boolean;
}

const SEVERITY_NUMBER: Record<LogLevel, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

const LEVEL_METHOD: Readonly<
  Record<LogLevel, 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'>
> = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
};

const ERROR_LEVELS = new Set<LogLevel>(['ERROR', 'FATAL']);
const DEFAULT_METRIC_ATTRIBUTES = [
  'service.name',
  'next_logger.runtime',
  'next_logger.level',
  'deployment.environment',
  'deployment.environment.name',
  'service.namespace',
  'service.version',
] as const;
const FORBIDDEN_METRIC_ATTRIBUTES = new Set([
  'trace.id',
  'span.id',
  'log.record.uid',
  OTEL_FIELD_KEYS.spanId,
  OTEL_FIELD_KEYS.parentSpanId,
  OTEL_FIELD_KEYS.traceState,
]);

const NOOP_SPAN: OtelSpanLike = Object.freeze({
  spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
  isRecording: () => false,
  addEvent: () => undefined,
  recordException: () => undefined,
  setStatus: () => undefined,
  end: () => undefined,
});

function reportDiagnostic(
  callback: ((error: unknown, operation: string) => void) | undefined,
  error: unknown,
  operation: string,
): void {
  try {
    callback?.(error, operation);
  } catch {
    // Diagnostic callbacks must never become recursive telemetry failures.
  }
}

function traceStateText(
  traceState: OtelSpanContextLike['traceState'],
  onError?: (error: unknown) => void,
): string | undefined {
  if (!traceState) {
    return undefined;
  }
  if (typeof traceState === 'string') {
    return boundedString(traceState, MAX_TRACE_STATE_LENGTH);
  }
  try {
    const serialized = traceState.serialize?.();
    return serialized ? boundedString(serialized, MAX_TRACE_STATE_LENGTH) : undefined;
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

function validSpanContext(context: OtelSpanContextLike | undefined): context is OtelSpanContextLike {
  return Boolean(
    context &&
      isValidTraceId(context.traceId) &&
      isValidSpanId(context.spanId) &&
      isValidTraceFlags(context.traceFlags),
  );
}

function safeIsRecording(
  span: OtelSpanLike,
  onError: (error: unknown) => void,
): boolean {
  if (typeof span.isRecording !== 'function') {
    return true;
  }
  try {
    return span.isRecording() !== false;
  } catch (error) {
    onError(error);
    return false;
  }
}

function errorFromRecord(record: LogRecord): Error | Record<string, unknown> | undefined {
  const first = record.errors?.[0];
  if (!first) {
    return undefined;
  }
  if (typeof first === 'object' && !Array.isArray(first)) {
    const message = typeof first.message === 'string' ? first.message : record.message;
    const error = new Error(message);
    if (typeof first.name === 'string') {
      error.name = first.name;
    }
    if (typeof first.stack === 'string') {
      error.stack = first.stack;
    }
    return error;
  }
  return { message: String(first) };
}

function safeDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function addRecordAttributes(
  builder: AttributeBuilder,
  record: LogRecord,
  options: Pick<
    OpenTelemetryTransportOptions,
    'attributes' | 'includeFields' | 'includeValues'
  >,
): void {
  for (const [key, value] of Object.entries(options.attributes ?? {})) {
    builder.set(key, value);
  }
  builder.set('log.record.uid', record.id);
  builder.set('service.name', record.appName);
  builder.set('next_logger.schema', record.schema);
  builder.set('next_logger.runtime', String(record.runtime));
  builder.set('next_logger.level', record.level);
  if (record.name) builder.set('logger.name', record.name);
  if (record.traceId && isValidTraceId(record.traceId)) builder.set('trace.id', record.traceId);
  if (record.routineId) builder.set('next_logger.routine_id', record.routineId);
  if (record.tags?.length) builder.set('next_logger.tags', record.tags);

  if (options.includeFields ?? true) {
    for (const [key, value] of Object.entries(record.fields)) {
      builder.set(`next_logger.field.${key}`, value);
    }
  }
  if (options.includeValues) {
    builder.set('next_logger.values', stableJson(record.values));
  }
}

function addCorrelationAttributes(
  builder: AttributeBuilder,
  record: LogRecord,
  spanContext: OtelSpanContextLike | undefined,
  onTraceStateError?: (error: unknown) => void,
): void {
  if (spanContext) {
    builder.set('trace.id', spanContext.traceId);
    builder.set('span.id', spanContext.spanId);
    builder.set(OTEL_FIELD_KEYS.traceFlags, spanContext.traceFlags);
    const state = traceStateText(spanContext.traceState, onTraceStateError);
    if (state) builder.set(OTEL_FIELD_KEYS.traceState, state);
    if (spanContext.isRemote !== undefined) {
      builder.set(OTEL_FIELD_KEYS.remote, spanContext.isRemote);
    }
    return;
  }

  const spanId = record.fields[OTEL_FIELD_KEYS.spanId];
  const flags = record.fields[OTEL_FIELD_KEYS.traceFlags];
  const traceState = record.fields[OTEL_FIELD_KEYS.traceState];
  const remote = record.fields[OTEL_FIELD_KEYS.remote];
  if (record.traceId && isValidTraceId(record.traceId) && isValidSpanId(spanId)) {
    builder.set('trace.id', record.traceId);
    builder.set('span.id', spanId);
    if (isValidTraceFlags(flags)) builder.set(OTEL_FIELD_KEYS.traceFlags, flags);
    if (typeof traceState === 'string') {
      builder.set(OTEL_FIELD_KEYS.traceState, boundedString(traceState, MAX_TRACE_STATE_LENGTH));
    }
    if (typeof remote === 'boolean') builder.set(OTEL_FIELD_KEYS.remote, remote);
  }
}

/** Converts the stable next-loggers record into bounded OTEL attributes. */
export function logRecordToOtelAttributes(
  record: LogRecord,
  options: Pick<
    OpenTelemetryTransportOptions,
    'attributes' | 'includeFields' | 'includeValues' | 'maxAttributes' |
      'maxAttributeValueLength' | 'maxArrayLength'
  > = {},
): OtelAttributes {
  const builder = new AttributeBuilder(normalizedLimits(options));
  addRecordAttributes(builder, record, options);
  return builder.values;
}

function metricAttributes(record: LogRecord, options: OpenTelemetryTransportOptions): OtelAttributes {
  const builder = new AttributeBuilder({
    maxAttributes: 16,
    maxAttributeValueLength: 256,
    maxArrayLength: 16,
  });
  builder.set('service.name', record.appName);
  builder.set('next_logger.runtime', String(record.runtime));
  builder.set('next_logger.level', record.level);
  for (const [key, value] of Object.entries(options.attributes ?? {})) {
    if (!FORBIDDEN_METRIC_ATTRIBUTES.has(key) && !key.startsWith('next_logger.field.')) {
      builder.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(options.metricAttributes ?? {})) {
    if (FORBIDDEN_METRIC_ATTRIBUTES.has(key) || key.startsWith('next_logger.field.')) {
      continue;
    }
    builder.set(key, value);
  }
  const allowed = options.metricAttributeKeys ?? [
    ...DEFAULT_METRIC_ATTRIBUTES,
    ...Object.keys(options.metricAttributes ?? {}),
  ];
  return selectMetricAttributes(builder.values, allowed);
}

function selectMetricAttributes(
  attributes: OtelAttributes,
  allowed: readonly string[] | undefined,
): OtelAttributes {
  const selected: OtelAttributes = {};
  for (const key of allowed ?? DEFAULT_METRIC_ATTRIBUTES) {
    const value = attributes[key];
    if (value !== undefined) {
      selected[key] = value;
    }
  }
  return selected;
}

/**
 * Reads trace correlation from an application-owned active span and exposes it
 * through next-loggers' existing context provider contract. Valid non-recording
 * spans are retained by default: sampling controls span export, not log
 * correlation. Only span events and exception recording require a recording
 * span.
 */
export function createOpenTelemetryContextProvider(
  activeSpan: () => OtelSpanLike | null | undefined,
  options: OpenTelemetryContextProviderOptions = {},
): LogContextProvider {
  if (typeof activeSpan !== 'function') {
    throw new TypeError('createOpenTelemetryContextProvider requires an activeSpan callback');
  }
  return () => {
    let span: OtelSpanLike | null | undefined;
    try {
      span = activeSpan();
    } catch (error) {
      reportDiagnostic(options.onBridgeError, error, 'active-span');
      return undefined;
    }
    if (!span) {
      return undefined;
    }
    if (
      options.requireRecordingSpan === true &&
      !safeIsRecording(span, (error) => reportDiagnostic(options.onBridgeError, error, 'is-recording'))
    ) {
      return undefined;
    }

    let context: OtelSpanContextLike;
    try {
      context = span.spanContext();
    } catch (error) {
      reportDiagnostic(options.onBridgeError, error, 'span-context');
      return undefined;
    }
    if (!validSpanContext(context)) {
      return undefined;
    }
    const state = traceStateText(
      context.traceState,
      (error) => reportDiagnostic(options.onBridgeError, error, 'trace-state'),
    );
    return {
      traceId: context.traceId,
      traceIds: [context.traceId],
      fields: {
        [OTEL_FIELD_KEYS.spanId]: context.spanId,
        [OTEL_FIELD_KEYS.traceFlags]: context.traceFlags,
        ...(state ? { [OTEL_FIELD_KEYS.traceState]: state } : {}),
        ...(context.isRemote !== undefined ? { [OTEL_FIELD_KEYS.remote]: context.isRemote } : {}),
      },
      tags: ['otel'],
    };
  };
}

/**
 * Explicit OTEL transport. Logger calls remain the only application-facing API;
 * the transport forwards already-redacted records to application-owned OTEL
 * log/span/metric objects. It performs no global registration, require hooks,
 * prototype mutation, or automatic instrumentation.
 *
 * logger.emit() is the primary delivery operation and its failure is propagated
 * to next-loggers. Optional span events, exception recording, status updates,
 * and metric hooks are isolated and reported through onBridgeError.
 */
export class OpenTelemetryTransport implements LogTransport {
  readonly name = 'opentelemetry';
  readonly otel = true;
  private forceFlushOperation: Promise<void> | undefined;

  constructor(private readonly options: OpenTelemetryTransportOptions) {
    if (!options?.logger || typeof options.logger.emit !== 'function') {
      throw new TypeError('OpenTelemetryTransport requires an injected OTEL logger with emit()');
    }
    if ((options.forceFlushCallbacks?.length ?? 0) > 32) {
      throw new RangeError('OpenTelemetryTransport accepts at most 32 forceFlush callbacks');
    }
    if (options.forceFlushCallbacks?.some((callback) => typeof callback !== 'function')) {
      throw new TypeError('forceFlushCallbacks must contain functions');
    }
  }

  private diagnostic(
    error: unknown,
    bridgeOperation: string,
    legacyOperation: string,
    record: LogRecord,
  ): void {
    reportDiagnostic(this.options.onBridgeError, error, bridgeOperation);
    try {
      this.options.onError?.(error, legacyOperation, record);
    } catch {
      // Legacy diagnostics are isolated for the same reason as onBridgeError.
    }
  }

  write(record: LogRecord): void {
    let span: OtelSpanLike | undefined;
    try {
      span = this.options.activeSpan?.() ?? undefined;
    } catch (error) {
      this.diagnostic(error, 'active-span', 'read active span', record);
    }

    let spanContext: OtelSpanContextLike | undefined;
    if (span) {
      try {
        const candidate = span.spanContext();
        if (validSpanContext(candidate)) {
          spanContext = candidate;
        }
      } catch (error) {
        this.diagnostic(error, 'span-context', 'read span context', record);
      }
    }

    const builder = new AttributeBuilder(normalizedLimits(this.options));
    addRecordAttributes(builder, record, this.options);
    addCorrelationAttributes(
      builder,
      record,
      spanContext,
      (error) => this.diagnostic(error, 'trace-state', 'serialize trace state', record),
    );
    const attributes = builder.values;

    let activeContext: unknown;
    try {
      activeContext = this.options.activeContext?.();
    } catch (error) {
      this.diagnostic(error, 'active-context', 'read active context', record);
    }

    const timestamp = safeDate(record.timestamp);
    let emitFailure: unknown;
    try {
      this.options.logger.emit({
        body: record.message,
        severityNumber: SEVERITY_NUMBER[record.level],
        severityText: record.level,
        attributes,
        timestamp,
        ...(activeContext !== undefined ? { context: activeContext } : {}),
      });
    } catch (error) {
      emitFailure = error;
      this.diagnostic(error, 'logger.emit', 'emit log', record);
    }

    if (span && (this.options.emitSpanEvents ?? true)) {
      const recording = safeIsRecording(
        span,
        (error) => this.diagnostic(error, 'is-recording', 'check span recording state', record),
      );
      if (recording) {
        try {
          span.addEvent(`log.${record.level.toLowerCase()}`, attributes, timestamp);
        } catch (error) {
          this.diagnostic(error, 'span-event', 'add span event', record);
        }
        if (ERROR_LEVELS.has(record.level)) {
          const exception = errorFromRecord(record);
          if ((this.options.recordExceptions ?? true) && exception) {
            try {
              span.recordException?.(exception, timestamp);
            } catch (error) {
              this.diagnostic(error, 'record-exception', 'record exception', record);
            }
          }
          try {
            span.setStatus?.({ code: 2, message: boundedString(record.message, 1_024) });
          } catch (error) {
            this.diagnostic(error, 'span-status', 'set span status', record);
          }
        }
      }
    }

    const labels = metricAttributes(record, this.options);
    try {
      this.options.recordMetric?.('next_loggers.records', 1, labels);
    } catch (error) {
      this.diagnostic(error, 'metric', 'record log metric', record);
    }
    if (ERROR_LEVELS.has(record.level)) {
      try {
        this.options.recordMetric?.('next_loggers.errors', 1, labels);
      } catch (error) {
        this.diagnostic(error, 'metric', 'record error metric', record);
      }
    }

    if (emitFailure !== undefined && this.options.failOpen === false) {
      throw emitFailure;
    }
  }

  /**
   * Force-flush every injected application-owned provider exactly once per
   * concurrent flush wave. Failures are reported and propagated to the logger,
   * whose default drain remains fail-open unless `throwOnError` is requested.
   */
  flush(): Promise<void> {
    const active = this.forceFlushOperation;
    if (active) return active;
    const callbacks = this.options.forceFlushCallbacks ?? [];
    if (callbacks.length === 0) return Promise.resolve();

    const operation = Promise.allSettled(callbacks.map(async (callback) => callback())).then(
      (results) => {
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        for (const failure of failures) {
          reportDiagnostic(this.options.onBridgeError, failure, 'provider.forceFlush');
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'application-owned OTEL provider forceFlush failed');
        }
      },
    );
    this.forceFlushOperation = operation;
    void operation.then(
      () => {
        if (this.forceFlushOperation === operation) this.forceFlushOperation = undefined;
      },
      () => {
        if (this.forceFlushOperation === operation) this.forceFlushOperation = undefined;
      },
    );
    return operation;
  }
}

export function createOpenTelemetryTransport(
  options: OpenTelemetryTransportOptions,
): OpenTelemetryTransport {
  return new OpenTelemetryTransport(options);
}

/**
 * Returns a child logger that preserves normal transports and context while
 * adding an explicit application-owned OTEL transport/context bridge.
 */
export function withOpenTelemetry(
  logger: BaseLogger,
  options: OpenTelemetryTransportOptions,
): BaseLogger;
export function withOpenTelemetry(
  logger: LoggerOptions,
  options: OpenTelemetryTransportOptions,
): LoggerOptions;
export function withOpenTelemetry(
  logger: BaseLogger | LoggerOptions,
  options: OpenTelemetryTransportOptions,
): BaseLogger | LoggerOptions {
  const otelContext = options.activeSpan
    ? createOpenTelemetryContextProvider(options.activeSpan)
    : undefined;
  if (
    typeof (logger as BaseLogger).anew !== 'function' ||
    typeof (logger as BaseLogger).getTransports !== 'function'
  ) {
    const loggerOptions = logger as LoggerOptions;
    const existing = loggerOptions.transports
      ? Array.isArray(loggerOptions.transports)
        ? loggerOptions.transports
        : [loggerOptions.transports]
      : [];
    const contextProvider = loggerOptions.contextProvider ?? otelContext;
    return {
      ...loggerOptions,
      transports: [...existing, createOpenTelemetryTransport(options)],
      ...(contextProvider ? { contextProvider } : {}),
    };
  }
  const baseLogger = logger as BaseLogger;
  return baseLogger.anew({
    transports: [...baseLogger.getTransports(), createOpenTelemetryTransport(options)],
    ...(otelContext
      ? {
          contextProvider: () => {
            const inherited = baseLogger.getContext();
            const telemetry = otelContext();
            if (!inherited) return telemetry;
            if (!telemetry) return inherited;
            return {
              ...inherited,
              ...telemetry,
              loggedInUser: { ...inherited.loggedInUser, ...telemetry.loggedInUser },
              users: [...(inherited.users ?? []), ...(telemetry.users ?? [])],
              fields: { ...inherited.fields, ...telemetry.fields },
              traceIds: Array.from(new Set([
                ...(inherited.traceIds ?? []),
                ...(telemetry.traceIds ?? []),
              ])),
              tags: Array.from(new Set([...(inherited.tags ?? []), ...(telemetry.tags ?? [])])),
            };
          },
        }
      : {}),
  });
}

function normalizeLifecycleLevel(
  level: Lowercase<LogLevel> | LogLevel | false | undefined,
): LogLevel | false {
  if (level === false) {
    return false;
  }
  const normalized = String(level ?? 'DEBUG').toUpperCase() as LogLevel;
  return normalized in LEVEL_METHOD ? normalized : 'DEBUG';
}

function spanFields(span: OtelSpanLike, extra: LogFields | undefined): LogFields {
  let context: OtelSpanContextLike | undefined;
  try {
    context = span.spanContext();
  } catch {
    context = undefined;
  }
  return {
    ...(context?.traceId ? { 'otel.trace_id': context.traceId } : {}),
    ...(context?.spanId ? { 'otel.span_id': context.spanId } : {}),
    ...(context ? { 'otel.trace_flags': context.traceFlags } : {}),
    ...extra,
  };
}

async function logSafely(
  logger: BaseLogger,
  level: LogLevel,
  message: string,
  fields: LogFields,
  tags: readonly string[],
  error?: unknown,
): Promise<void> {
  try {
    const method = LEVEL_METHOD[level];
    const event = error === undefined
      ? logger[method](message)
      : logger[method](message, error);
    await event.addFields(fields).addTags('otel-span', ...tags).send();
  } catch {
    // A log sink failure cannot replace the application result.
  }
}

async function invokeSpanSafely(
  logger: BaseLogger,
  operation: string,
  callback: () => void,
  fields: LogFields,
  tags: readonly string[],
): Promise<void> {
  try {
    callback();
  } catch (error) {
    await logSafely(
      logger,
      'WARN',
      `OpenTelemetry ${operation} failed`,
      { ...fields, 'otel.bridge_operation': operation },
      ['otel-bridge-error', ...tags],
      error,
    );
  }
}

/**
 * Explicit span wrapper. Start, success and failure lifecycle records are sent
 * through next-loggers while the application supplies the tracer and context
 * implementation. Span cleanup failures are reported but never replace a
 * successful callback result.
 */
export async function withOpenTelemetrySpan<T>(
  logger: BaseLogger,
  tracer: OtelTracerLike,
  name: string,
  callback: (span: OtelSpanLike) => T | Promise<T>,
  options: WithOpenTelemetrySpanOptions = {},
): Promise<T> {
  if (!logger || typeof logger.info !== 'function') {
    throw new TypeError('withOpenTelemetrySpan requires a next-loggers logger');
  }
  if (!tracer || typeof tracer.startActiveSpan !== 'function') {
    throw new TypeError('withOpenTelemetrySpan requires an injected OTEL tracer');
  }
  const {
    lifecycleLevel: rawLifecycleLevel,
    logFields,
    tags = [],
    okStatusCode = 1,
    errorStatusCode = 2,
    failOnStartError = false,
    ...spanOptions
  } = options;
  const lifecycleLevel = normalizeLifecycleLevel(rawLifecycleLevel);
  let callbackStarted = false;
  try {
    return await tracer.startActiveSpan(name, spanOptions, async (span) => {
      callbackStarted = true;
      const startedAt = globalThis.performance?.now?.() ?? Date.now();
      const contextFields = spanFields(span, logFields);
      if (lifecycleLevel !== false) {
        await logSafely(
          logger,
          lifecycleLevel,
          `span started: ${name}`,
          { ...contextFields, 'otel.span_name': name, 'otel.span_phase': 'start' },
          tags,
        );
      }
      try {
        const result = await callback(span);
        if (safeIsRecording(span, () => undefined)) {
          await invokeSpanSafely(
            logger,
            'set success status',
            () => span.setStatus?.({ code: okStatusCode }),
            contextFields,
            tags,
          );
        }
        if (lifecycleLevel !== false) {
          await logSafely(
            logger,
            lifecycleLevel,
            `span completed: ${name}`,
            {
              ...contextFields,
              'otel.span_name': name,
              'otel.span_phase': 'end',
              'otel.duration_ms': Math.max(
                0,
                (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
              ),
            },
            tags,
          );
        }
        return result;
      } catch (error) {
        if (safeIsRecording(span, () => undefined)) {
          await invokeSpanSafely(
            logger,
            'record exception',
            () => {
              span.recordException?.(
                error instanceof Error ? error : { message: String(error) },
              );
            },
            contextFields,
            tags,
          );
          await invokeSpanSafely(
            logger,
            'set error status',
            () => {
              span.setStatus?.({
                code: errorStatusCode,
                ...(error instanceof Error && error.message ? { message: error.message } : {}),
              });
            },
            contextFields,
            tags,
          );
        }
        await logSafely(
          logger,
          'ERROR',
          `span failed: ${name}`,
          {
            ...contextFields,
            'otel.span_name': name,
            'otel.span_phase': 'error',
            'otel.duration_ms': Math.max(
              0,
              (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
            ),
          },
          tags,
          error,
        );
        throw error;
      } finally {
        await invokeSpanSafely(
          logger,
          'end span',
          () => span.end?.(),
          contextFields,
          tags,
        );
      }
    });
  } catch (error) {
    if (!callbackStarted) {
      await logSafely(
        logger,
        'ERROR',
        `OpenTelemetry start span failed: ${name}`,
        { ...logFields, 'otel.span_name': name, 'otel.span_phase': 'start-error' },
        ['otel-bridge-error', ...tags],
        error,
      );
      if (!failOnStartError) {
        return await callback(NOOP_SPAN);
      }
    }
    throw error;
  }
}
