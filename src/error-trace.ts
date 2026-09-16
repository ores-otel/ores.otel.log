import type { LogRecord, SerializedValue } from './base-logger.js';

export const ORES_ERROR_TRACE_VERSION = 1 as const;
export const ORES_TRACE_HEADER = 'x-ores-trace-id' as const;

const ORES_TRACE_ID_RE = /^ores-trace-[A-Za-z0-9_-]{12,64}$/u;
const ORES_ROUTINE_ID_RE = /^ores-routine-[A-Za-z0-9_-]{12,64}$/u;
const OTEL_TRACE_ID_RE = /^[0-9a-f]{32}$/u;
const OTEL_SPAN_ID_RE = /^[0-9a-f]{16}$/u;
const RELEASE_SHA_RE = /^[0-9a-f]{7,64}$/u;

export interface OresErrorTraceTelemetryV1 {
  version: 1;
  kind: 'error';
  service: string;
  environment?: string;
  repository?: string;
  release_sha?: string;
  trace_id?: string;
  parent_trace_id?: string;
  otel_trace_id?: string;
  otel_span_id?: string;
  exception_type?: string;
  error_type?: string;
  error_code?: string;
  message?: string;
  error_list?: string[];
  top_frame?: string;
  operation?: string;
  severity?: string;
  runtime?: string;
  source?: string;
  routine_id?: string;
  file_name?: string;
}

export interface ErrorTraceTelemetryOptions {
  service?: string;
  environment?: string;
  repository?: string;
  releaseSha?: string;
  parentTraceId?: string;
  otelTraceId?: string;
  otelSpanId?: string;
  exceptionType?: string;
  errorType?: string;
  errorCode?: string;
  operation?: string;
  severity?: string;
  source?: string;
  fileName?: string;
}

export type OresTraceHeaderCarrier =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

function boundedIdentity(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new TypeError(`${field} exceeds ${max} characters`);
  return trimmed;
}

function boundedText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : value.slice(0, max);
}

function requiredIdentity(value: string, field: string, max: number): string {
  const normalized = boundedIdentity(value, field, max);
  if (!normalized) throw new TypeError(`${field} must be a non-empty string`);
  return normalized;
}

function assertPattern(value: string | undefined, field: string, pattern: RegExp): string | undefined {
  if (value === undefined) return undefined;
  if (!pattern.test(value)) throw new TypeError(`invalid ${field}: ${value}`);
  return value;
}

function serializedObject(value: SerializedValue | undefined): Record<string, SerializedValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function serializedString(value: SerializedValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recordField(record: LogRecord, key: string): string | undefined {
  return serializedString(record.fields[key]);
}

function errorMessage(value: SerializedValue): string | undefined {
  if (typeof value === 'string') return boundedText(value, 8192);
  const object = serializedObject(value);
  return boundedText(serializedString(object?.message), 8192);
}

function firstErrorObject(record: LogRecord): Record<string, SerializedValue> | undefined {
  return record.errors?.map(serializedObject).find((value) => value !== undefined);
}

function errorList(record: LogRecord): string[] | undefined {
  const values = (record.errors ?? [])
    .map(errorMessage)
    .filter((value): value is string => Boolean(value))
    .slice(0, 32);
  return values.length ? values : undefined;
}

export function isOresTraceId(value: string): boolean {
  return ORES_TRACE_ID_RE.test(value);
}

export function isOresRoutineId(value: string): boolean {
  return ORES_ROUTINE_ID_RE.test(value);
}

export function isOtelTraceId(value: string): boolean {
  return OTEL_TRACE_ID_RE.test(value);
}

export function isOtelSpanId(value: string): boolean {
  return OTEL_SPAN_ID_RE.test(value);
}

export function isReleaseSha(value: string): boolean {
  return RELEASE_SHA_RE.test(value);
}

export function buildErrorTraceTelemetry(
  record: LogRecord,
  options: ErrorTraceTelemetryOptions = {},
): OresErrorTraceTelemetryV1 {
  const firstError = firstErrorObject(record);
  const environment = boundedIdentity(options.environment ?? recordField(record, 'environment'), 'environment', 128);
  const repository = boundedIdentity(options.repository ?? recordField(record, 'repository'), 'repository', 256);
  const releaseSha = assertPattern(options.releaseSha ?? recordField(record, 'release_sha'), 'release_sha', RELEASE_SHA_RE);
  const traceId = assertPattern(record.traceId, 'trace_id', ORES_TRACE_ID_RE);
  const parentTraceId = assertPattern(options.parentTraceId ?? recordField(record, 'parent_trace_id'), 'parent_trace_id', ORES_TRACE_ID_RE);
  const otelTraceId = assertPattern(options.otelTraceId ?? recordField(record, 'otel_trace_id'), 'otel_trace_id', OTEL_TRACE_ID_RE);
  const otelSpanId = assertPattern(options.otelSpanId ?? recordField(record, 'otel_span_id'), 'otel_span_id', OTEL_SPAN_ID_RE);
  const routineId = assertPattern(record.routineId, 'routine_id', ORES_ROUTINE_ID_RE);
  const exceptionType = boundedIdentity(
    options.exceptionType
      ?? serializedString(firstError?.exception_type)
      ?? serializedString(firstError?.name),
    'exception_type',
    256,
  );
  const errorType = boundedIdentity(
    options.errorType
      ?? recordField(record, 'error_type')
      ?? serializedString(firstError?.type),
    'error_type',
    128,
  );
  const errorCode = boundedIdentity(
    options.errorCode
      ?? recordField(record, 'error_code')
      ?? serializedString(firstError?.code),
    'error_code',
    128,
  );
  const operation = boundedText(options.operation ?? recordField(record, 'operation'), 512);
  const severity = boundedText(options.severity ?? record.level.toLowerCase(), 32);
  const runtime = boundedText(String(record.runtime), 64);
  const source = boundedText(options.source ?? 'ores.otel.log', 128);
  const fileName = boundedText(options.fileName ?? recordField(record, 'file_name'), 1024);
  const topFrame = boundedText(record.stackTrace?.[0], 1024);
  const errors = errorList(record);
  const message = boundedText(record.message, 8192);

  return {
    version: ORES_ERROR_TRACE_VERSION,
    kind: 'error',
    service: requiredIdentity(options.service ?? record.appName, 'service', 256),
    ...(environment ? { environment } : {}),
    ...(repository ? { repository } : {}),
    ...(releaseSha ? { release_sha: releaseSha } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
    ...(parentTraceId ? { parent_trace_id: parentTraceId } : {}),
    ...(otelTraceId ? { otel_trace_id: otelTraceId } : {}),
    ...(otelSpanId ? { otel_span_id: otelSpanId } : {}),
    ...(exceptionType ? { exception_type: exceptionType } : {}),
    ...(errorType ? { error_type: errorType } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(errors ? { error_list: errors } : {}),
    ...(topFrame ? { top_frame: topFrame } : {}),
    ...(operation ? { operation } : {}),
    ...(severity ? { severity } : {}),
    ...(runtime ? { runtime } : {}),
    ...(source ? { source } : {}),
    ...(routineId ? { routine_id: routineId } : {}),
    ...(fileName ? { file_name: fileName } : {}),
  };
}

export function buildOresTraceHeaders(traceId: string): Readonly<Record<typeof ORES_TRACE_HEADER, string>> {
  const admitted = assertPattern(traceId, 'trace_id', ORES_TRACE_ID_RE);
  if (!admitted) throw new TypeError('trace_id is required');
  return Object.freeze({ [ORES_TRACE_HEADER]: admitted });
}

export function readOresTraceIdHeader(headers: OresTraceHeaderCarrier): string | undefined {
  const raw = headers instanceof Headers
    ? headers.get(ORES_TRACE_HEADER) ?? undefined
    : Object.entries(headers)
      .find(([key]) => key.toLowerCase() === ORES_TRACE_HEADER)?.[1];
  const value = Array.isArray(raw)
    ? raw.length === 1 ? raw[0] : (() => { throw new TypeError('ambiguous x-ores-trace-id header'); })()
    : raw;
  return assertPattern(value, 'x-ores-trace-id', ORES_TRACE_ID_RE);
}
