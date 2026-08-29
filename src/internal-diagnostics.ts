/**
 * Independent, payload-free diagnostics for failures inside observability code.
 *
 * This module is safe for browser and edge bundles. It imports no cloud SDK,
 * never accepts free-form error text, and treats signed upload URLs as
 * temporary credentials that cannot be serialized back out of the grant.
 */

export const INTERNAL_DIAGNOSTIC_SCHEMA = 'ores.otel.log/internal-diagnostic/v1' as const;
export const INTERNAL_DIAGNOSTIC_BATCH_SCHEMA =
  'ores.otel.log/internal-diagnostic-batch/v1' as const;
export const INTERNAL_DIAGNOSTIC_UPLOAD_GRANT_SCHEMA =
  'ores.otel.log/internal-diagnostic-upload-grant/v1' as const;
export const INTERNAL_DIAGNOSTIC_CONTENT_TYPE =
  'application/vnd.ores.internal-diagnostics+json' as const;

export const MAX_INTERNAL_DIAGNOSTIC_BATCH_RECORDS = 64;
export const MAX_INTERNAL_DIAGNOSTIC_BATCH_BYTES = 64 * 1024;
export const MAX_INTERNAL_DIAGNOSTIC_GRANT_TTL_MILLIS = 15 * 60 * 1000;
export const MAX_INTERNAL_DIAGNOSTIC_ATTEMPTS = 8;
export const MAX_INTERNAL_DIAGNOSTIC_COUNTER = 65_535;

const COMPONENTS = [
  'otel_bridge',
  'loki_transport',
  'prometheus_exporter',
  'supabase_transport',
  'cloudwatch_logs',
  'google_cloud_logging',
  'azure_monitor',
  'outage_spool',
  'collector',
  'sidecar',
] as const;

const OPERATIONS = [
  'exporter_initialize',
  'exporter_write',
  'exporter_flush',
  'transport_send',
  'transport_flush',
  'queue_overflow',
  'queue_retry',
  'shutdown_flush',
  'provider_write',
  'provider_flush',
  'upload_grant_validate',
  'upload_put',
  'sidecar_configure',
  'sidecar_listen',
  'sidecar_probe',
] as const;

const SEVERITIES = ['warn', 'error', 'fatal'] as const;
const OUTCOMES = ['failed', 'dropped', 'suppressed', 'rejected', 'recovered'] as const;
const PROVIDERS = ['aws_s3', 'gcp_cloud_storage', 'azure_blob'] as const;

export type InternalDiagnosticComponent = (typeof COMPONENTS)[number];
export type InternalDiagnosticOperation = (typeof OPERATIONS)[number];
export type InternalDiagnosticSeverity = (typeof SEVERITIES)[number];
export type InternalDiagnosticOutcome = (typeof OUTCOMES)[number];
export type InternalDiagnosticUploadProvider = (typeof PROVIDERS)[number];

export interface InternalDiagnosticRecord {
  readonly schema: typeof INTERNAL_DIAGNOSTIC_SCHEMA;
  readonly timestamp: string;
  readonly service: string;
  readonly severity: InternalDiagnosticSeverity;
  readonly component: InternalDiagnosticComponent;
  readonly operation: InternalDiagnosticOperation;
  readonly outcome: InternalDiagnosticOutcome;
  readonly retryable: boolean;
  readonly attempt: number;
  readonly dropped: number;
  readonly suppressed: number;
  readonly suppressionSaturated: boolean;
}

export interface InternalDiagnosticBatch {
  readonly schema: typeof INTERNAL_DIAGNOSTIC_BATCH_SCHEMA;
  readonly createdAt: string;
  readonly records: readonly InternalDiagnosticRecord[];
}

export interface InternalDiagnosticInput {
  readonly severity: InternalDiagnosticSeverity;
  readonly operation: InternalDiagnosticOperation;
  readonly outcome: InternalDiagnosticOutcome;
  readonly retryable?: boolean;
  readonly attempt?: number;
  readonly dropped?: number;
}

interface CanonicalInternalDiagnosticInput {
  readonly severity: InternalDiagnosticSeverity;
  readonly operation: InternalDiagnosticOperation;
  readonly outcome: InternalDiagnosticOutcome;
  readonly retryable: boolean;
  readonly attempt: number;
  readonly dropped: number;
}

export type InternalDiagnosticSink = (
  record: Readonly<InternalDiagnosticRecord>,
) => void | Promise<void>;

export type InternalDiagnosticReporterState = 'idle' | 'reporting' | 'closing' | 'closed';

export interface InternalDiagnosticReporterSnapshot {
  readonly state: InternalDiagnosticReporterState;
  readonly suppressed: number;
  readonly suppressionSaturated: boolean;
}

export type InternalDiagnosticReportResult =
  | { readonly status: 'delivered'; readonly sinkIndex: number }
  | { readonly status: 'sinks_failed' }
  | { readonly status: 'suppressed' }
  | { readonly status: 'closed' };

export interface InternalDiagnosticReporterOptions {
  readonly service: string;
  readonly component: InternalDiagnosticComponent;
  readonly sinks: readonly InternalDiagnosticSink[];
  readonly now?: () => Date;
}

export type OtelBridgeDiagnosticHook = (error: unknown, operation: string) => void;

export interface InternalDiagnosticUploadGrantInput {
  readonly schema: typeof INTERNAL_DIAGNOSTIC_UPLOAD_GRANT_SCHEMA;
  readonly provider: InternalDiagnosticUploadProvider;
  readonly method: 'PUT';
  readonly uploadUrl: string;
  readonly expiresAt: string;
  readonly maxBytes: number;
  readonly contentType: typeof INTERNAL_DIAGNOSTIC_CONTENT_TYPE;
  readonly headers: Readonly<Record<string, string>>;
}

export interface InternalDiagnosticUploadGrantMetadata {
  readonly schema: typeof INTERNAL_DIAGNOSTIC_UPLOAD_GRANT_SCHEMA;
  readonly provider: InternalDiagnosticUploadProvider;
  readonly method: 'PUT';
  readonly uploadUrl: '[REDACTED]';
  readonly expiresAt: string;
  readonly maxBytes: number;
  readonly contentType: typeof INTERNAL_DIAGNOSTIC_CONTENT_TYPE;
  readonly headers: readonly string[];
}

export type InternalDiagnosticUploadResult =
  | { readonly status: 'uploaded' }
  | { readonly status: 'rejected'; readonly reason: 'expired' | 'oversized' | 'invalid_batch' }
  | { readonly status: 'failed'; readonly reason: 'network' | 'provider_rejected' };

export interface InternalDiagnosticUploadOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMillis?: number;
  readonly nowMillis?: () => number;
}

const GRANT_URLS = new WeakMap<InternalDiagnosticUploadGrant, URL>();
const GRANT_HEADERS = new WeakMap<InternalDiagnosticUploadGrant, Readonly<Record<string, string>>>();
const CONSUMED_GRANTS = new WeakSet<InternalDiagnosticUploadGrant>();
const PORTABLE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function includes<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === 'string' && values.includes(value as Values[number]);
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function ownDataValues(
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): Readonly<Record<string, unknown>> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    return undefined;
  }
  const allowed = new Set(allowedKeys);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => {
      if (typeof key !== 'string' || !allowed.has(key)) return true;
      const descriptor = descriptors[key];
      return !descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value');
    }) ||
    requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    return undefined;
  }
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key === 'string') values[key] = descriptors[key]?.value;
  }
  return Object.freeze(values);
}

function validService(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    PORTABLE_SERVICE.test(value)
  );
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 35 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

const INTERNAL_DIAGNOSTIC_RECORD_KEYS = [
  'schema',
  'timestamp',
  'service',
  'severity',
  'component',
  'operation',
  'outcome',
  'retryable',
  'attempt',
  'dropped',
  'suppressed',
  'suppressionSaturated',
] as const;

function maybeCanonicalInternalDiagnosticRecord(
  record: unknown,
): InternalDiagnosticRecord | undefined {
  const value = ownDataValues(record, INTERNAL_DIAGNOSTIC_RECORD_KEYS);
  if (!value) return undefined;
  if (!(
    value.schema === INTERNAL_DIAGNOSTIC_SCHEMA &&
    validTimestamp(value.timestamp) &&
    validService(value.service) &&
    includes(SEVERITIES, value.severity) &&
    includes(COMPONENTS, value.component) &&
    includes(OPERATIONS, value.operation) &&
    includes(OUTCOMES, value.outcome) &&
    typeof value.retryable === 'boolean' &&
    boundedInteger(value.attempt, MAX_INTERNAL_DIAGNOSTIC_ATTEMPTS) &&
    boundedInteger(value.dropped, MAX_INTERNAL_DIAGNOSTIC_COUNTER) &&
    boundedInteger(value.suppressed, MAX_INTERNAL_DIAGNOSTIC_COUNTER) &&
    typeof value.suppressionSaturated === 'boolean'
  )) {
    return undefined;
  }
  return Object.freeze({
    schema: value.schema,
    timestamp: value.timestamp,
    service: value.service,
    severity: value.severity,
    component: value.component,
    operation: value.operation,
    outcome: value.outcome,
    retryable: value.retryable,
    attempt: value.attempt,
    dropped: value.dropped,
    suppressed: value.suppressed,
    suppressionSaturated: value.suppressionSaturated,
  });
}

/** Runtime guard for the exact, payload-free wire record. */
export function isInternalDiagnosticRecord(record: unknown): record is InternalDiagnosticRecord {
  return maybeCanonicalInternalDiagnosticRecord(record) !== undefined;
}

/** Validate and copy a record so accessors, proxies, and prototypes cannot alter delivery. */
export function canonicalizeInternalDiagnosticRecord(
  record: unknown,
): InternalDiagnosticRecord {
  const canonical = maybeCanonicalInternalDiagnosticRecord(record);
  if (!canonical) throw new TypeError('invalid internal diagnostic record');
  return canonical;
}

function canonicalizeInput(input: InternalDiagnosticInput): CanonicalInternalDiagnosticInput {
  const allowedKeys = [
    'severity',
    'operation',
    'outcome',
    'retryable',
    'attempt',
    'dropped',
  ];
  const value = ownDataValues(input, allowedKeys, ['severity', 'operation', 'outcome']);
  const severity = value?.severity;
  const operation = value?.operation;
  const outcome = value?.outcome;
  const retryable = value?.retryable;
  const attempt = value?.attempt;
  const dropped = value?.dropped;
  if (
    !value ||
    !includes(SEVERITIES, severity) ||
    !includes(OPERATIONS, operation) ||
    !includes(OUTCOMES, outcome) ||
    (retryable !== undefined && typeof retryable !== 'boolean') ||
    (attempt !== undefined && !boundedInteger(attempt, MAX_INTERNAL_DIAGNOSTIC_ATTEMPTS)) ||
    (dropped !== undefined && !boundedInteger(dropped, MAX_INTERNAL_DIAGNOSTIC_COUNTER))
  ) {
    throw new TypeError('invalid internal diagnostic input');
  }
  return Object.freeze({
    severity,
    operation,
    outcome,
    retryable: retryable ?? false,
    attempt: attempt ?? 0,
    dropped: dropped ?? 0,
  });
}

function saturatingIncrement(value: number): [number, boolean] {
  if (value >= MAX_INTERNAL_DIAGNOSTIC_COUNTER) {
    return [MAX_INTERNAL_DIAGNOSTIC_COUNTER, true];
  }
  return [value + 1, false];
}

/**
 * Fail-open reporter with a serialized, non-reentrant sink state machine.
 *
 * Concurrent and recursively generated diagnostics are not queued. They are
 * accounted for in the next emitted record, with an explicit saturation bit.
 */
export class InternalDiagnosticReporter {
  private state: InternalDiagnosticReporterState = 'idle';
  private suppressed = 0;
  private suppressionSaturated = false;
  private inFlight: Promise<InternalDiagnosticReportResult> | undefined;
  private readonly service: string;
  private readonly component: InternalDiagnosticComponent;
  private readonly sinks: readonly InternalDiagnosticSink[];
  private readonly now: () => Date;

  constructor(options: InternalDiagnosticReporterOptions) {
    if (!validService(options.service)) {
      throw new TypeError('internal diagnostic service must be a bounded portable name');
    }
    if (!includes(COMPONENTS, options.component)) {
      throw new TypeError('invalid internal diagnostic component');
    }
    if (options.sinks.length < 1 || options.sinks.length > 3) {
      throw new RangeError('internal diagnostics require between one and three sinks');
    }
    if (options.sinks.some((sink) => typeof sink !== 'function')) {
      throw new TypeError('internal diagnostic sinks must be functions');
    }
    this.service = options.service;
    this.component = options.component;
    this.sinks = Object.freeze([...options.sinks]);
    this.now = options.now ?? (() => new Date());
  }

  snapshot(): InternalDiagnosticReporterSnapshot {
    return Object.freeze({
      state: this.state,
      suppressed: this.suppressed,
      suppressionSaturated: this.suppressionSaturated,
    });
  }

  private accountSuppressed(): void {
    const [next, saturated] = saturatingIncrement(this.suppressed);
    this.suppressed = next;
    this.suppressionSaturated ||= saturated;
  }

  private async deliver(record: InternalDiagnosticRecord): Promise<InternalDiagnosticReportResult> {
    for (const [sinkIndex, sink] of this.sinks.entries()) {
      try {
        await sink(record);
        return { status: 'delivered', sinkIndex };
      } catch {
        // A diagnostic sink must never report its own failure through this reporter.
      }
    }
    return { status: 'sinks_failed' };
  }

  async report(input: InternalDiagnosticInput): Promise<InternalDiagnosticReportResult> {
    if (this.state === 'closed') return { status: 'closed' };
    if (this.state !== 'idle') {
      this.accountSuppressed();
      return { status: 'suppressed' };
    }
    const canonicalInput = canonicalizeInput(input);
    const suppressed = this.suppressed;
    const suppressionSaturated = this.suppressionSaturated;
    this.suppressed = 0;
    this.suppressionSaturated = false;
    this.state = 'reporting';
    // Defer every injected callback until after the in-flight promise is
    // installed. Reentrant clocks and sinks must observe one atomic admission.
    const delivery = Promise.resolve()
      .then(() => {
        const record = Object.freeze({
          schema: INTERNAL_DIAGNOSTIC_SCHEMA,
          timestamp: this.now().toISOString(),
          service: this.service,
          severity: canonicalInput.severity,
          component: this.component,
          operation: canonicalInput.operation,
          outcome: canonicalInput.outcome,
          retryable: canonicalInput.retryable,
          attempt: canonicalInput.attempt,
          dropped: canonicalInput.dropped,
          suppressed,
          suppressionSaturated,
        } satisfies InternalDiagnosticRecord);
        return this.deliver(record);
      })
      .catch((): InternalDiagnosticReportResult => ({ status: 'sinks_failed' }));
    this.inFlight = delivery;
    try {
      return await delivery;
    } finally {
      this.inFlight = undefined;
      const currentState = this.state as InternalDiagnosticReporterState;
      this.state = currentState === 'closing' ? 'closed' : 'idle';
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    if (this.state === 'idle') {
      this.state = 'closed';
      return;
    }
    this.state = 'closing';
    await this.inFlight;
    this.state = 'closed';
  }
}

/**
 * Adapt the OpenTelemetry bridge error callback to the closed control plane.
 *
 * The original error and operation text are intentionally discarded: either
 * may contain application payloads, URLs, headers, or provider credentials.
 */
export function createOtelBridgeDiagnosticHook(
  reporter: InternalDiagnosticReporter,
): OtelBridgeDiagnosticHook {
  return (_error, operation) => {
    const flushOperation = operation === 'provider.forceFlush' || operation.includes('flush');
    void reporter
      .report({
        severity: 'error',
        operation: flushOperation ? 'exporter_flush' : 'exporter_write',
        outcome: 'failed',
        retryable: true,
      })
      .catch(() => {
        // A bridge diagnostic is advisory and must not break the telemetry caller.
      });
  };
}

/** Build and byte-check a closed outage-spool batch. */
export function createInternalDiagnosticBatch(
  records: readonly InternalDiagnosticRecord[],
  now: () => Date = () => new Date(),
): InternalDiagnosticBatch {
  if (records.length < 1 || records.length > MAX_INTERNAL_DIAGNOSTIC_BATCH_RECORDS) {
    throw new TypeError('invalid internal diagnostic batch');
  }
  const canonicalRecords = records.map(maybeCanonicalInternalDiagnosticRecord);
  if (canonicalRecords.some((record) => record === undefined)) {
    throw new TypeError('invalid internal diagnostic batch');
  }
  const batch = Object.freeze({
    schema: INTERNAL_DIAGNOSTIC_BATCH_SCHEMA,
    createdAt: now().toISOString(),
    records: Object.freeze(canonicalRecords as InternalDiagnosticRecord[]),
  } satisfies InternalDiagnosticBatch);
  if (new TextEncoder().encode(JSON.stringify(batch)).byteLength > MAX_INTERNAL_DIAGNOSTIC_BATCH_BYTES) {
    throw new RangeError('internal diagnostic batch exceeds the byte limit');
  }
  return batch;
}

function validProviderHost(provider: InternalDiagnosticUploadProvider, hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (provider === 'aws_s3') {
    return (
      host === 's3.amazonaws.com' ||
      /(?:^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/u.test(host)
    );
  }
  if (provider === 'gcp_cloud_storage') {
    return host === 'storage.googleapis.com' || host.endsWith('.storage.googleapis.com');
  }
  return [
    '.blob.core.windows.net',
    '.blob.core.usgovcloudapi.net',
    '.blob.core.chinacloudapi.cn',
  ].some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

function basicIsoMillis(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(value);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  if (parts.length !== 6) return undefined;
  const [year, month, day, hour, minute, second] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const millis = Date.UTC(year, month - 1, day, hour, minute, second);
  const canonical = new Date(millis).toISOString().replaceAll('-', '').replaceAll(':', '').replace('.000', '');
  return canonical === value ? millis : undefined;
}

function uniqueQueryValue(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && values[0] !== '' ? values[0] : undefined;
}

function validSignedHeaders(value: string): boolean {
  const headers = value.split(';');
  return (
    headers.length === new Set(headers).size &&
    headers.includes('host') &&
    headers.includes('content-type') &&
    headers.every((header) => /^[a-z0-9-]+$/u.test(header))
  );
}

function signedExpirationMillis(
  provider: InternalDiagnosticUploadProvider,
  url: URL,
): number | undefined {
  if (provider === 'azure_blob') {
    const expiry = uniqueQueryValue(url, 'se');
    const permission = uniqueQueryValue(url, 'sp');
    const resource = uniqueQueryValue(url, 'sr');
    const protocol = uniqueQueryValue(url, 'spr');
    const version = uniqueQueryValue(url, 'sv');
    const signature = uniqueQueryValue(url, 'sig');
    if (
      !expiry ||
      !version ||
      !signature ||
      signature.length < 16 ||
      (permission !== 'w' && permission !== 'cw') ||
      resource !== 'b' ||
      protocol !== 'https' ||
      url.searchParams.has('ss') ||
      url.searchParams.has('srt')
    ) {
      return undefined;
    }
    const parsed = Date.parse(expiry);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const prefix = provider === 'aws_s3' ? 'X-Amz-' : 'X-Goog-';
  const algorithm = uniqueQueryValue(url, `${prefix}Algorithm`);
  const credential = uniqueQueryValue(url, `${prefix}Credential`);
  const signature = uniqueQueryValue(url, `${prefix}Signature`);
  const date = uniqueQueryValue(url, `${prefix}Date`);
  const expires = uniqueQueryValue(url, `${prefix}Expires`);
  const signedHeaders = uniqueQueryValue(url, `${prefix}SignedHeaders`);
  const duration = Number(expires);
  const signedAt = date ? basicIsoMillis(date) : undefined;
  const validAlgorithm =
    provider === 'aws_s3'
      ? algorithm === 'AWS4-HMAC-SHA256' && credential?.endsWith('/s3/aws4_request')
      : algorithm === 'GOOG4-RSA-SHA256' && credential?.endsWith('/storage/goog4_request');
  if (
    !validAlgorithm ||
    !signature ||
    !/^[a-fA-F0-9]{32,1024}$/u.test(signature) ||
    !signedHeaders ||
    !validSignedHeaders(signedHeaders) ||
    signedAt === undefined
  ) {
    return undefined;
  }
  if (!Number.isInteger(duration) || duration < 1 || duration > 900) return undefined;
  return signedAt + duration * 1000;
}

function validatedHeaders(
  provider: InternalDiagnosticUploadProvider,
  input: unknown,
): Readonly<Record<string, string>> | undefined {
  const values = ownDataValues(input, ['content-type', 'x-ms-blob-type'], ['content-type']);
  if (!values) return undefined;
  const contentType = values['content-type'];
  const blobType = values['x-ms-blob-type'];
  if (contentType !== INTERNAL_DIAGNOSTIC_CONTENT_TYPE) return undefined;
  if (provider === 'azure_blob') {
    if (blobType !== 'BlockBlob') return undefined;
  } else if (blobType !== undefined) {
    return undefined;
  }
  const headers: Record<string, string> = { 'content-type': contentType };
  if (blobType === 'BlockBlob') headers['x-ms-blob-type'] = blobType;
  return Object.freeze(headers);
}

/**
 * Opaque validated upload grant. JSON serialization always redacts the URL.
 */
export class InternalDiagnosticUploadGrant {
  readonly provider: InternalDiagnosticUploadProvider;
  readonly expiresAt: string;
  readonly maxBytes: number;

  private constructor(
    provider: InternalDiagnosticUploadProvider,
    expiresAt: string,
    maxBytes: number,
  ) {
    this.provider = provider;
    this.expiresAt = expiresAt;
    this.maxBytes = maxBytes;
  }

  static parse(
    input: InternalDiagnosticUploadGrantInput,
    nowMillis: number = Date.now(),
  ): InternalDiagnosticUploadGrant {
    const value = ownDataValues(input, [
      'schema',
      'provider',
      'method',
      'uploadUrl',
      'expiresAt',
      'maxBytes',
      'contentType',
      'headers',
    ]);
    const provider = value?.provider;
    const uploadUrl = value?.uploadUrl;
    const expiresAt = value?.expiresAt;
    const maxBytes = value?.maxBytes;
    if (
      !value ||
      value.schema !== INTERNAL_DIAGNOSTIC_UPLOAD_GRANT_SCHEMA ||
      !includes(PROVIDERS, provider) ||
      value.method !== 'PUT' ||
      value.contentType !== INTERNAL_DIAGNOSTIC_CONTENT_TYPE ||
      typeof uploadUrl !== 'string' ||
      uploadUrl.length < 32 ||
      uploadUrl.length > 8192 ||
      !boundedInteger(maxBytes, MAX_INTERNAL_DIAGNOSTIC_BATCH_BYTES) ||
      maxBytes < 256 ||
      !validTimestamp(expiresAt)
    ) {
      throw new TypeError('invalid internal diagnostic upload grant');
    }
    const expiresAtMillis = Date.parse(expiresAt);
    if (
      expiresAtMillis <= nowMillis ||
      expiresAtMillis - nowMillis > MAX_INTERNAL_DIAGNOSTIC_GRANT_TTL_MILLIS
    ) {
      throw new TypeError('internal diagnostic upload grant expiry is invalid');
    }

    let url: URL;
    try {
      url = new URL(uploadUrl);
    } catch {
      throw new TypeError('internal diagnostic upload grant URL is invalid');
    }
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.hash !== '' ||
      url.pathname === '/' ||
      !validProviderHost(provider, url.hostname)
    ) {
      throw new TypeError('internal diagnostic upload grant URL is invalid');
    }
    const signedExpiry = signedExpirationMillis(provider, url);
    if (
      signedExpiry === undefined ||
      expiresAtMillis > signedExpiry ||
      signedExpiry > nowMillis + MAX_INTERNAL_DIAGNOSTIC_GRANT_TTL_MILLIS
    ) {
      throw new TypeError('internal diagnostic upload signature expiry is invalid');
    }
    const headers = validatedHeaders(provider, value.headers);
    if (!headers) throw new TypeError('internal diagnostic upload headers are invalid');

    const grant = new InternalDiagnosticUploadGrant(
      provider,
      expiresAt,
      maxBytes,
    );
    GRANT_URLS.set(grant, url);
    GRANT_HEADERS.set(grant, headers);
    return Object.freeze(grant);
  }

  toJSON(): InternalDiagnosticUploadGrantMetadata {
    const headers = GRANT_HEADERS.get(this);
    return Object.freeze({
      schema: INTERNAL_DIAGNOSTIC_UPLOAD_GRANT_SCHEMA,
      provider: this.provider,
      method: 'PUT',
      uploadUrl: '[REDACTED]',
      expiresAt: this.expiresAt,
      maxBytes: this.maxBytes,
      contentType: INTERNAL_DIAGNOSTIC_CONTENT_TYPE,
      headers: Object.freeze(Object.keys(headers ?? {}).sort()),
    });
  }
}

function canonicalBatch(batch: unknown): InternalDiagnosticBatch | undefined {
  const value = ownDataValues(batch, ['schema', 'createdAt', 'records']);
  if (
    !value ||
    value.schema !== INTERNAL_DIAGNOSTIC_BATCH_SCHEMA ||
    !validTimestamp(value.createdAt) ||
    !Array.isArray(value.records)
  ) {
    return undefined;
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value.records) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    return undefined;
  }
  const length = descriptors.length?.value as unknown;
  if (
    !Number.isInteger(length) ||
    Number(length) < 1 ||
    Number(length) > MAX_INTERNAL_DIAGNOSTIC_BATCH_RECORDS ||
    Reflect.ownKeys(descriptors).some((key) => {
      if (key === 'length') return false;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key)) return true;
      const index = Number(key);
      const descriptor = descriptors[key];
      return (
        index >= Number(length) ||
        !descriptor ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      );
    })
  ) {
    return undefined;
  }
  const records: InternalDiagnosticRecord[] = [];
  for (let index = 0; index < Number(length); index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
    const record = maybeCanonicalInternalDiagnosticRecord(descriptor.value);
    if (!record) return undefined;
    records.push(record);
  }
  return Object.freeze({
    schema: INTERNAL_DIAGNOSTIC_BATCH_SCHEMA,
    createdAt: value.createdAt,
    records: Object.freeze(records),
  }) as InternalDiagnosticBatch;
}

/** Upload one bounded batch with no redirects, cookies, referrer, or retry. */
export async function uploadInternalDiagnosticBatch(
  grant: InternalDiagnosticUploadGrant,
  batch: InternalDiagnosticBatch,
  options: InternalDiagnosticUploadOptions = {},
): Promise<InternalDiagnosticUploadResult> {
  const nowMillis = options.nowMillis?.() ?? Date.now();
  if (Date.parse(grant.expiresAt) <= nowMillis) {
    return { status: 'rejected', reason: 'expired' };
  }
  const canonical = canonicalBatch(batch);
  if (!canonical) return { status: 'rejected', reason: 'invalid_batch' };
  const body = JSON.stringify(canonical);
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > grant.maxBytes || bytes > MAX_INTERNAL_DIAGNOSTIC_BATCH_BYTES) {
    return { status: 'rejected', reason: 'oversized' };
  }

  const url = GRANT_URLS.get(grant);
  const headers = GRANT_HEADERS.get(grant);
  if (!url || !headers || CONSUMED_GRANTS.has(grant)) {
    return { status: 'rejected', reason: 'invalid_batch' };
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') return { status: 'failed', reason: 'network' };
  const controller = new AbortController();
  const timeoutMillis = Math.max(100, Math.min(options.timeoutMillis ?? 5_000, 10_000));
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMillis);
  CONSUMED_GRANTS.add(grant);
  try {
    const response = await fetchImplementation(url, {
      method: 'PUT',
      headers,
      body,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: controller.signal,
    });
    return response.ok
      ? { status: 'uploaded' }
      : { status: 'failed', reason: 'provider_rejected' };
  } catch {
    return { status: 'failed', reason: 'network' };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
