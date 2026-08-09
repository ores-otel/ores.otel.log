import type {
  LogContextProvider,
  LogLevel,
  LogRecord,
  LogTransport,
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
 * or enabling automatic instrumentation/monkey patching in application code.
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
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
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
    this.maximum = positiveInteger(limits.maxAttributes, DEFAULT_ATTRIBUTE_LIMIT);
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

export interface OpenTelemetryTransportOptions extends OtelAttributeLimits {
  /** Logger obtained by the application from its chosen OpenTelemetry SDK. */
  logger: OtelLoggerLike;
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
  /** Optional metrics hook backed by an application-owned OTEL meter. */
  recordMetric?: (name: string, value: number, attributes: OtelAttributes) => void;
  /** Optional diagnostic hook for bridge side effects other than logger.emit(). */
  onBridgeError?: (error: unknown, operation: string) => void;
}

export interface OpenTelemetryContextProviderOptions {
  /** Require a recording span. Defaults to false so sampled-out traces still correlate logs. */
  requireRecordingSpan?: boolean;
  onBridgeError?: (error: unknown, operation: string) => void;
}

const SEVERITY_NUMBER: Record<LogLevel, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

const ERROR_LEVELS = new Set<LogLevel>(['ERROR', 'FATAL']);
const FORBIDDEN_METRIC_ATTRIBUTES = new Set([
  'trace.id',
  'span.id',
  'log.record.uid',
  OTEL_FIELD_KEYS.spanId,
  OTEL_FIELD_KEYS.parentSpanId,
  OTEL_FIELD_KEYS.traceState,
]);

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
  builder.set('log.record.uid', record.id);
  builder.set('service.name', record.appName);
  builder.set('next_logger.schema', record.schema);
  builder.set('next_logger.runtime', String(record.runtime));
  builder.set('next_logger.level', record.level);
  if (record.name) builder.set('logger.name', record.name);
  if (record.traceId && isValidTraceId(record.traceId)) builder.set('trace.id', record.traceId);
  if (record.routineId) builder.set('next_logger.routine_id', record.routineId);
  if (record.tags?.length) builder.set('next_logger.tags', record.tags);

  for (const [key, value] of Object.entries(options.attributes ?? {})) {
    builder.set(key, value);
  }
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
  const builder = new AttributeBuilder(options);
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
  for (const [key, value] of Object.entries(options.metricAttributes ?? {})) {
    if (FORBIDDEN_METRIC_ATTRIBUTES.has(key) || key.startsWith('next_logger.field.')) {
      continue;
    }
    builder.set(key, value);
  }
  return builder.values;
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

  constructor(private readonly options: OpenTelemetryTransportOptions) {
    if (!options?.logger || typeof options.logger.emit !== 'function') {
      throw new TypeError('OpenTelemetryTransport requires logger.emit()');
    }
  }

  write(record: LogRecord): void {
    let span: OtelSpanLike | undefined;
    try {
      span = this.options.activeSpan?.() ?? undefined;
    } catch (error) {
      reportDiagnostic(this.options.onBridgeError, error, 'active-span');
    }

    let spanContext: OtelSpanContextLike | undefined;
    if (span) {
      try {
        const candidate = span.spanContext();
        if (validSpanContext(candidate)) {
          spanContext = candidate;
        }
      } catch (error) {
        reportDiagnostic(this.options.onBridgeError, error, 'span-context');
      }
    }

    const builder = new AttributeBuilder(this.options);
    addRecordAttributes(builder, record, this.options);
    addCorrelationAttributes(
      builder,
      record,
      spanContext,
      (error) => reportDiagnostic(this.options.onBridgeError, error, 'trace-state'),
    );
    const attributes = builder.values;

    let activeContext: unknown;
    try {
      activeContext = this.options.activeContext?.();
    } catch (error) {
      reportDiagnostic(this.options.onBridgeError, error, 'active-context');
    }

    const timestamp = safeDate(record.timestamp);
    this.options.logger.emit({
      body: record.message,
      severityNumber: SEVERITY_NUMBER[record.level],
      severityText: record.level,
      attributes,
      timestamp,
      ...(activeContext !== undefined ? { context: activeContext } : {}),
    });

    if (span && (this.options.emitSpanEvents ?? true)) {
      const recording = safeIsRecording(
        span,
        (error) => reportDiagnostic(this.options.onBridgeError, error, 'is-recording'),
      );
      if (recording) {
        try {
          span.addEvent(`log.${record.level.toLowerCase()}`, attributes, timestamp);
        } catch (error) {
          reportDiagnostic(this.options.onBridgeError, error, 'span-event');
        }
        if (ERROR_LEVELS.has(record.level)) {
          const exception = errorFromRecord(record);
          if ((this.options.recordExceptions ?? true) && exception) {
            try {
              span.recordException?.(exception, timestamp);
            } catch (error) {
              reportDiagnostic(this.options.onBridgeError, error, 'record-exception');
            }
          }
          try {
            span.setStatus?.({ code: 2, message: boundedString(record.message, 1_024) });
          } catch (error) {
            reportDiagnostic(this.options.onBridgeError, error, 'span-status');
          }
        }
      }
    }

    const labels = metricAttributes(record, this.options);
    try {
      this.options.recordMetric?.('next_loggers.records', 1, labels);
      if (ERROR_LEVELS.has(record.level)) {
        this.options.recordMetric?.('next_loggers.errors', 1, labels);
      }
    } catch (error) {
      reportDiagnostic(this.options.onBridgeError, error, 'metric');
    }
  }
}

export function createOpenTelemetryTransport(
  options: OpenTelemetryTransportOptions,
): OpenTelemetryTransport {
  return new OpenTelemetryTransport(options);
}
