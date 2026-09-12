/**
 * `.ores-otel.toml` v1: strict parsing, contract validation, and deterministic
 * layered resolution. The parsed snake_case object is governed by
 * ores-otel/ores-otel-interfaces (TypeSpec + JSON Schema peers, TJSV-admitted);
 * the TypeScript, Dart, and Rust loaders must resolve the shared fixtures in
 * tests/fixtures/ores-otel-config (plus the lookup corpus next to it)
 * identically. See docs/ores-otel-config.md.
 *
 * Precedence:
 * `defaults < common < selected role < environment < flagOverrides < overrides`.
 */
import { readFile } from 'node:fs/promises';
import {
  createLogger,
  LOG_LEVELS,
  type BaseLogger,
  type LoggerOptions,
  type LogLevel,
} from './base-logger.js';
import { parseToml } from './cli/toml.js';

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};

export const ORES_OTEL_CONFIG_BASENAME = '.ores-otel.toml';
export const ORES_OTEL_CONFIG_VERSION = 1 as const;

export type OresOtelRole = 'client' | 'server' | 'shared';
export type OresOtelRuntimeRole = Exclude<OresOtelRole, 'shared'>;
export type OresOtelLogLevel = Lowercase<LogLevel>;
export type OresOtelExporterProtocol = 'none' | 'otlp_http' | 'otlp_grpc';
export type OresOtelPropagator = 'tracecontext' | 'baggage';

/** Thrown for every malformed file, environment value, flag, or override. */
export class OresOtelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OresOtelConfigError';
  }
}

/**
 * Every environment variable the loader reads. `contracts/ores-otel.cli-flags.toml`
 * declares exactly this set; tests/ores-otel-config-flags.test.mjs fails on drift.
 */
export const ORES_OTEL_ENV_VARIABLES = Object.freeze([
  'ORES_OTEL_ROLE',
  'ORES_OTEL_CONFIG_DIR',
  'ORES_OTEL_CONFIG_FILE',
  'ORES_OTEL_ENABLED',
  'ORES_OTEL_SERVICE_NAME',
  'ORES_OTEL_ENVIRONMENT',
  'ORES_OTEL_LOGGING_ENABLED',
  'ORES_OTEL_LOG_LEVEL',
  'ORES_OTEL_LOG_CONSOLE',
  'ORES_OTEL_LOG_AUTO_SEND',
  'ORES_OTEL_TRACING_ENABLED',
  'ORES_OTEL_TRACE_SAMPLE_RATIO',
  'ORES_OTEL_PROPAGATORS',
  'ORES_OTEL_METRICS_ENABLED',
  'ORES_OTEL_METRICS_PROCESS_ENABLED',
  'ORES_OTEL_METRICS_SAMPLE_INTERVAL_MS',
  'ORES_OTEL_METRICS_FILESYSTEM_ENABLED',
  'ORES_OTEL_METRICS_FILESYSTEM_PATHS',
  'ORES_OTEL_METRICS_MIN_FREE_BYTES',
  'ORES_OTEL_METRICS_MIN_FREE_RATIO',
  'ORES_OTEL_METRICS_LATENCY_ENABLED',
  'ORES_OTEL_METRICS_HISTOGRAM_BOUNDARIES_MS',
  'ORES_OTEL_METRICS_RUNTIME_ENABLED',
  'ORES_OTEL_METRICS_SATURATION_ENABLED',
  'ORES_OTEL_METRICS_MEMORY_RATIO_WARNING',
  'ORES_OTEL_EXPORTER_PROTOCOL',
  'ORES_OTEL_EXPORTER_ENDPOINT_ENV',
] as const);

// ---------------------------------------------------------------------------
// Parsed file shape (snake_case, contract-governed)
// ---------------------------------------------------------------------------

export interface OresOtelFileLoggingConfig {
  enabled?: boolean;
  level?: string;
  console?: boolean;
  auto_send?: boolean;
}

export interface OresOtelFileTracingConfig {
  enabled?: boolean;
  sample_ratio?: number;
  propagators?: string[];
}

export interface OresOtelFileProcessMetricsConfig {
  enabled?: boolean;
  sample_interval_ms?: number;
  rss_bytes?: boolean;
  virtual_memory_bytes?: boolean;
  heap_bytes?: boolean;
  cpu_seconds?: boolean;
  thread_count?: boolean;
  open_file_descriptors?: boolean;
}

export interface OresOtelFileFilesystemMetricsConfig {
  enabled?: boolean;
  paths?: string[];
  capacity_bytes?: boolean;
  free_bytes?: boolean;
  free_ratio?: boolean;
  inode_free_ratio?: boolean;
  min_free_bytes?: number;
  min_free_ratio?: number;
  min_inode_free_ratio?: number;
}

export interface OresOtelFileLatencyMetricsConfig {
  enabled?: boolean;
  request_duration_ms?: boolean;
  operation_duration_ms?: boolean;
  queue_wait_ms?: boolean;
  event_loop_lag_ms?: boolean;
  histogram_boundaries_ms?: number[];
}

export interface OresOtelFileRuntimeMetricsConfig {
  enabled?: boolean;
  gc_pause_ms?: boolean;
  gc_heap_bytes?: boolean;
  event_loop_utilization?: boolean;
  scheduler_queue_depth?: boolean;
}

export interface OresOtelFileSaturationMetricsConfig {
  enabled?: boolean;
  cpu_ratio_warning?: number;
  memory_ratio_warning?: number;
  disk_free_ratio_warning?: number;
  queue_depth_warning?: number;
}

export interface OresOtelFileMetricsConfig {
  enabled?: boolean;
  exemplars?: boolean;
  span_metrics?: boolean;
  service_graphs?: boolean;
  process?: OresOtelFileProcessMetricsConfig;
  filesystem?: OresOtelFileFilesystemMetricsConfig;
  latency?: OresOtelFileLatencyMetricsConfig;
  runtime?: OresOtelFileRuntimeMetricsConfig;
  saturation?: OresOtelFileSaturationMetricsConfig;
}

export interface OresOtelFileExporterConfig {
  protocol?: string;
  endpoint_env?: string;
}

export interface OresOtelFileLayer {
  enabled?: boolean;
  service_name?: string;
  environment?: string;
  logging?: OresOtelFileLoggingConfig;
  tracing?: OresOtelFileTracingConfig;
  metrics?: OresOtelFileMetricsConfig;
  exporter?: OresOtelFileExporterConfig;
}

/**
 * Parsed `.ores-otel.toml` object. This snake_case shape is the object governed
 * by ores-otel/ores-otel-interfaces and its TypeSpec/JSON-Schema peer authorities.
 */
export interface OresOtelFileConfigV1 {
  version: 1;
  common?: OresOtelFileLayer;
  client?: OresOtelFileLayer;
  server?: OresOtelFileLayer;
}

// ---------------------------------------------------------------------------
// Resolved runtime shape (camelCase, deeply frozen)
// ---------------------------------------------------------------------------

export interface OresOtelLoggingConfig {
  enabled: boolean;
  level: OresOtelLogLevel;
  console: boolean;
  autoSend: boolean;
}

export interface OresOtelTracingConfig {
  enabled: boolean;
  sampleRatio: number;
  propagators: OresOtelPropagator[];
}

export interface OresOtelProcessMetricsConfig {
  enabled: boolean;
  sampleIntervalMs: number;
  rssBytes: boolean;
  virtualMemoryBytes: boolean;
  heapBytes: boolean;
  cpuSeconds: boolean;
  threadCount: boolean;
  openFileDescriptors: boolean;
}

export interface OresOtelFilesystemMetricsConfig {
  enabled: boolean;
  paths: string[];
  capacityBytes: boolean;
  freeBytes: boolean;
  freeRatio: boolean;
  inodeFreeRatio: boolean;
  minFreeBytes?: number;
  minFreeRatio?: number;
  minInodeFreeRatio?: number;
}

export interface OresOtelLatencyMetricsConfig {
  enabled: boolean;
  requestDurationMs: boolean;
  operationDurationMs: boolean;
  queueWaitMs: boolean;
  eventLoopLagMs: boolean;
  histogramBoundariesMs: number[];
}

export interface OresOtelRuntimeMetricsConfig {
  enabled: boolean;
  gcPauseMs: boolean;
  gcHeapBytes: boolean;
  eventLoopUtilization: boolean;
  schedulerQueueDepth: boolean;
}

export interface OresOtelSaturationMetricsConfig {
  enabled: boolean;
  cpuRatioWarning?: number;
  memoryRatioWarning?: number;
  diskFreeRatioWarning?: number;
  queueDepthWarning?: number;
}

export interface OresOtelMetricsConfig {
  /**
   * Master switch. It does not rewrite sub-table flags; probes run only when
   * both this and the sub-table `enabled` are true.
   */
  enabled: boolean;
  process: OresOtelProcessMetricsConfig;
  filesystem: OresOtelFilesystemMetricsConfig;
  latency: OresOtelLatencyMetricsConfig;
  runtime: OresOtelRuntimeMetricsConfig;
  saturation: OresOtelSaturationMetricsConfig;
  exemplars: boolean;
  spanMetrics: boolean;
  serviceGraphs: boolean;
}

export interface OresOtelExporterConfig {
  protocol: OresOtelExporterProtocol;
  /** Name of the environment variable containing the actual exporter endpoint. */
  endpointEnv?: string;
}

export interface OresOtelMetricsLayer {
  enabled?: boolean;
  exemplars?: boolean;
  spanMetrics?: boolean;
  serviceGraphs?: boolean;
  process?: Partial<OresOtelProcessMetricsConfig>;
  filesystem?: Partial<OresOtelFilesystemMetricsConfig>;
  latency?: Partial<OresOtelLatencyMetricsConfig>;
  runtime?: Partial<OresOtelRuntimeMetricsConfig>;
  saturation?: Partial<OresOtelSaturationMetricsConfig>;
}

/** An explicit runtime override layer; validated exactly like a file layer. */
export interface OresOtelLayer {
  enabled?: boolean;
  serviceName?: string;
  environment?: string;
  logging?: Partial<OresOtelLoggingConfig>;
  tracing?: Partial<OresOtelTracingConfig>;
  metrics?: OresOtelMetricsLayer;
  exporter?: Partial<OresOtelExporterConfig>;
}

export interface ResolvedOresOtelConfig {
  version: 1;
  role: OresOtelRole;
  enabled: boolean;
  serviceName?: string;
  environment?: string;
  logging: OresOtelLoggingConfig;
  tracing: OresOtelTracingConfig;
  metrics: OresOtelMetricsConfig;
  exporter: OresOtelExporterConfig;
}

export type OresOtelEnv = Record<string, string | undefined>;
/** The string map flags-2-env produces from argv (ORES_OTEL_* name -> value). */
export type OresOtelFlagOverrides = Record<string, string>;

export interface ResolveOresOtelConfigOptions {
  /** Process environment; defaults to `process.env`. */
  env?: OresOtelEnv | undefined;
  role?: OresOtelRuntimeRole | undefined;
  /** flags-2-env overrides, applied on top of `env`. */
  flagOverrides?: OresOtelFlagOverrides | undefined;
  overrides?: OresOtelLayer | undefined;
}

export interface LoadOresOtelConfigOptions extends ResolveOresOtelConfigOptions {
  /** Directory containing `.ores-otel.toml`. See {@link oresOtelConfigFilePath}. */
  cwd?: string | undefined;
  /** Explicit config file path; outranks every other lookup input. */
  filePath?: string | undefined;
}

export interface LoadedOresOtelConfig {
  config: ResolvedOresOtelConfig;
  parsed: OresOtelFileConfigV1;
  filePath: string | null;
}

export const ORES_OTEL_DEFAULT_HISTOGRAM_BOUNDARIES_MS: readonly number[] = Object.freeze([
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
]);

// ---------------------------------------------------------------------------
// Contract validation over snake_case layers
// ---------------------------------------------------------------------------

type Plain = Record<string, unknown>;
type SectionParser = (value: unknown, path: string, context: ParseContext) => Plain;

interface ParseContext {
  /** Dotted TOML key paths written as float literals (`5000.0`). */
  readonly floats: ReadonlySet<string>;
}

const NO_FLOATS: ParseContext = Object.freeze({ floats: new Set<string>() });

const LOGGING_BOOLS = ['enabled', 'console', 'auto_send'] as const;
const METRICS_BOOLS = ['enabled', 'exemplars', 'span_metrics', 'service_graphs'] as const;
const PROCESS_BOOLS = [
  'enabled',
  'rss_bytes',
  'virtual_memory_bytes',
  'heap_bytes',
  'cpu_seconds',
  'thread_count',
  'open_file_descriptors',
] as const;
const FILESYSTEM_BOOLS = ['enabled', 'capacity_bytes', 'free_bytes', 'free_ratio', 'inode_free_ratio'] as const;
const LATENCY_BOOLS = [
  'enabled',
  'request_duration_ms',
  'operation_duration_ms',
  'queue_wait_ms',
  'event_loop_lag_ms',
] as const;
const RUNTIME_BOOLS = [
  'enabled',
  'gc_pause_ms',
  'gc_heap_bytes',
  'event_loop_utilization',
  'scheduler_queue_depth',
] as const;
const SATURATION_RATIOS = ['cpu_ratio_warning', 'memory_ratio_warning', 'disk_free_ratio_warning'] as const;

const keySet = (...groups: ReadonlyArray<readonly string[]>): ReadonlySet<string> => new Set(groups.flat());

const ROOT_KEYS = keySet(['version', 'common', 'client', 'server']);
const LAYER_KEYS = keySet(['enabled', 'service_name', 'environment', 'logging', 'tracing', 'metrics', 'exporter']);
const LOGGING_KEYS = keySet(LOGGING_BOOLS, ['level']);
const TRACING_KEYS = keySet(['enabled', 'sample_ratio', 'propagators']);
const EXPORTER_KEYS = keySet(['protocol', 'endpoint_env']);
const METRICS_KEYS = keySet(METRICS_BOOLS, ['process', 'filesystem', 'latency', 'runtime', 'saturation']);
const PROCESS_KEYS = keySet(PROCESS_BOOLS, ['sample_interval_ms']);
const FILESYSTEM_KEYS = keySet(FILESYSTEM_BOOLS, ['paths', 'min_free_bytes', 'min_free_ratio', 'min_inode_free_ratio']);
const LATENCY_KEYS = keySet(LATENCY_BOOLS, ['histogram_boundaries_ms']);
const RUNTIME_KEYS = keySet(RUNTIME_BOOLS);
const SATURATION_KEYS = keySet(['enabled', 'queue_depth_warning'], SATURATION_RATIOS);

const LOG_LEVELS_LOWER: ReadonlySet<string> = new Set(LOG_LEVELS.map((value) => value.toLowerCase()));
const EXPORTER_PROTOCOLS: ReadonlySet<string> = new Set<OresOtelExporterProtocol>(['none', 'otlp_http', 'otlp_grpc']);
const PROPAGATORS: ReadonlySet<string> = new Set<OresOtelPropagator>(['tracecontext', 'baggage']);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SENSITIVE_KEY = /(?:authorization|token|secret|password|cookie|api[_-]?key|private[_-]?key|headers?)/iu;

function fail(message: string): never {
  throw new OresOtelConfigError(message);
}

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compact(value: Plain): Plain {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function table(value: unknown, path: string, allowed: ReadonlySet<string>): Plain {
  if (!isPlain(value)) fail(`${path} must be a TOML table`);
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY.test(key)) {
      fail(`${path}.${key} is forbidden: credentials and secret-shaped settings do not belong in .ores-otel.toml`);
    }
    if (!allowed.has(key)) fail(`${path}.${key} is not a supported .ores-otel.toml v1 key`);
  }
  return value;
}

function bools(source: Plain, path: string, names: readonly string[]): Plain {
  return compact(
    Object.fromEntries(
      names.map((name) => {
        const value = source[name];
        if (value !== undefined && typeof value !== 'boolean') fail(`${path}.${name} must be a boolean`);
        return [name, value];
      }),
    ),
  );
}

function text(source: Plain, key: string, path: string, maximum: number): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${path}.${key} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    fail(`${path}.${key} must contain 1..${maximum} non-whitespace characters`);
  }
  return normalized;
}

interface NumberRule {
  readonly min: number;
  readonly max?: number;
  readonly integer?: boolean;
}

function numeric(source: Plain, key: string, path: string, context: ParseContext, rule: NumberRule): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  const integer = rule.integer === true;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && (!Number.isSafeInteger(value) || context.floats.has(`${path}.${key}`)))
  ) {
    fail(`${path}.${key} must be ${integer ? 'an integer' : 'a finite number'}`);
  }
  if (value < rule.min || (rule.max !== undefined && value > rule.max)) {
    fail(`${path}.${key} must be between ${rule.min} and ${rule.max ?? 'infinity'}`);
  }
  return value;
}

function list(source: Plain, key: string, path: string): readonly unknown[] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${path}.${key} must be an array`);
  return value;
}

function sections(source: Plain, path: string, context: ParseContext, parsers: Readonly<Record<string, SectionParser>>): Plain {
  return compact(
    Object.fromEntries(
      Object.entries(parsers).map(([key, parse]) => [
        key,
        source[key] === undefined ? undefined : parse(source[key], `${path}.${key}`, context),
      ]),
    ),
  );
}

/** Validates latency boundaries: 1..32 finite values, each > 0, strictly increasing. */
export function validateHistogramBoundaries(raw: readonly unknown[], path = 'histogram_boundaries_ms'): number[] {
  const values = raw.map((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0) {
      fail(`${path} must contain finite numbers greater than 0`);
    }
    return item;
  });
  if (values.length === 0 || values.length > 32) fail(`${path} must contain 1..32 entries`);
  if (values.some((value, index) => index > 0 && value <= (values[index - 1] ?? Number.NEGATIVE_INFINITY))) {
    fail(`${path} must be strictly increasing`);
  }
  return values;
}

const parseLogging: SectionParser = (value, path) => {
  const source = table(value, path, LOGGING_KEYS);
  const level = text(source, 'level', path, 16)?.toLowerCase();
  if (level !== undefined && !LOG_LEVELS_LOWER.has(level)) {
    fail(`${path}.level must be trace|debug|info|warn|error|fatal`);
  }
  return compact({ ...bools(source, path, LOGGING_BOOLS), level });
};

const parseTracing: SectionParser = (value, path, context) => {
  const source = table(value, path, TRACING_KEYS);
  const sampleRatio = numeric(source, 'sample_ratio', path, context, { min: 0, max: 1 });
  const propagators = list(source, 'propagators', path)?.map((item) => {
    if (typeof item !== 'string') fail(`${path}.propagators must be an array of strings`);
    const normalized = item.trim().toLowerCase();
    if (!PROPAGATORS.has(normalized)) fail(`${path}.propagators contains unsupported value ${normalized}`);
    return normalized;
  });
  if (propagators !== undefined) {
    if (propagators.length > 8) fail(`${path}.propagators may contain at most 8 entries`);
    if (new Set(propagators).size !== propagators.length) fail(`${path}.propagators must not contain duplicates`);
  }
  return compact({ ...bools(source, path, ['enabled']), sample_ratio: sampleRatio, propagators });
};

const parseExporter: SectionParser = (value, path) => {
  const source = table(value, path, EXPORTER_KEYS);
  const protocol = text(source, 'protocol', path, 32)?.toLowerCase();
  if (protocol !== undefined && !EXPORTER_PROTOCOLS.has(protocol)) {
    fail(`${path}.protocol must be none|otlp_http|otlp_grpc`);
  }
  const endpointEnv = text(source, 'endpoint_env', path, 128);
  if (endpointEnv !== undefined && !ENV_NAME.test(endpointEnv)) {
    fail(`${path}.endpoint_env must be an uppercase environment-variable name`);
  }
  return compact({ protocol, endpoint_env: endpointEnv });
};

const parseProcess: SectionParser = (value, path, context) => {
  const source = table(value, path, PROCESS_KEYS);
  return compact({
    ...bools(source, path, PROCESS_BOOLS),
    sample_interval_ms: numeric(source, 'sample_interval_ms', path, context, { min: 100, max: 3_600_000, integer: true }),
  });
};

const parseFilesystem: SectionParser = (value, path, context) => {
  const source = table(value, path, FILESYSTEM_KEYS);
  // Paths are validated as non-blank but deliberately not trimmed (Dart parity).
  const paths = list(source, 'paths', path)?.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') fail(`${path}.paths must contain non-empty strings`);
    return item;
  });
  if (paths !== undefined) {
    if (paths.length === 0 || paths.length > 32) fail(`${path}.paths must contain 1..32 entries`);
    if (new Set(paths).size !== paths.length) fail(`${path}.paths must not contain duplicates`);
  }
  return compact({
    ...bools(source, path, FILESYSTEM_BOOLS),
    paths,
    min_free_bytes: numeric(source, 'min_free_bytes', path, context, { min: 0, integer: true }),
    min_free_ratio: numeric(source, 'min_free_ratio', path, context, { min: 0, max: 1 }),
    min_inode_free_ratio: numeric(source, 'min_inode_free_ratio', path, context, { min: 0, max: 1 }),
  });
};

const parseLatency: SectionParser = (value, path) => {
  const source = table(value, path, LATENCY_KEYS);
  const raw = list(source, 'histogram_boundaries_ms', path);
  return compact({
    ...bools(source, path, LATENCY_BOOLS),
    histogram_boundaries_ms:
      raw === undefined ? undefined : validateHistogramBoundaries(raw, `${path}.histogram_boundaries_ms`),
  });
};

const parseRuntime: SectionParser = (value, path) => bools(table(value, path, RUNTIME_KEYS), path, RUNTIME_BOOLS);

const parseSaturation: SectionParser = (value, path, context) => {
  const source = table(value, path, SATURATION_KEYS);
  return compact({
    ...bools(source, path, ['enabled']),
    ...Object.fromEntries(SATURATION_RATIOS.map((name) => [name, numeric(source, name, path, context, { min: 0, max: 1 })])),
    queue_depth_warning: numeric(source, 'queue_depth_warning', path, context, { min: 0, integer: true }),
  });
};

const parseMetrics: SectionParser = (value, path, context) => {
  const source = table(value, path, METRICS_KEYS);
  return compact({
    ...bools(source, path, METRICS_BOOLS),
    ...sections(source, path, context, {
      process: parseProcess,
      filesystem: parseFilesystem,
      latency: parseLatency,
      runtime: parseRuntime,
      saturation: parseSaturation,
    }),
  });
};

const parseLayer: SectionParser = (value, path, context) => {
  const source = table(value, path, LAYER_KEYS);
  return compact({
    ...bools(source, path, ['enabled']),
    service_name: text(source, 'service_name', path, 256),
    environment: text(source, 'environment', path, 128),
    ...sections(source, path, context, {
      logging: parseLogging,
      tracing: parseTracing,
      metrics: parseMetrics,
      exporter: parseExporter,
    }),
  });
};

// ---------------------------------------------------------------------------
// Pure helpers: key casing, merging, freezing
// ---------------------------------------------------------------------------

function mapKeys(value: unknown, rename: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => mapKeys(item, rename));
  if (!isPlain(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [rename(key), mapKeys(item, rename)]));
}

const toSnake = (key: string): string => key.replace(/[A-Z]/gu, (char) => `_${char.toLowerCase()}`);
const toCamel = (key: string): string => key.replace(/_([a-z0-9])/gu, (_match, char: string) => char.toUpperCase());

/** Sub-tables merge key-by-key; scalars and arrays in `overlay` replace. */
function merge(base: Plain, overlay: Plain): Plain {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(overlay).map(([key, value]) => {
        const left = base[key];
        return [key, isPlain(left) && isPlain(value) ? merge(left, value) : value];
      }),
    ),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Strictly parses the tracked TOML file and applies runtime-only semantic checks. */
export function parseOresOtelToml(input: string): OresOtelFileConfigV1 {
  const floats = new Set<string>();
  const root = table(
    parseToml(input, { onFloat: (path) => floats.add(path.join('.')) }),
    'root',
    ROOT_KEYS,
  );
  if (root.version !== ORES_OTEL_CONFIG_VERSION || floats.has('version')) {
    fail(`root.version must equal ${ORES_OTEL_CONFIG_VERSION}`);
  }
  const context: ParseContext = { floats };
  const layer = (name: string): Plain | undefined =>
    root[name] === undefined ? undefined : parseLayer(root[name], name, context);
  return deepFreeze(
    compact({ version: ORES_OTEL_CONFIG_VERSION, common: layer('common'), client: layer('client'), server: layer('server') }),
  ) as unknown as OresOtelFileConfigV1;
}

// ---------------------------------------------------------------------------
// Environment and flags-2-env overrides
// ---------------------------------------------------------------------------

type EnvParser = (raw: string, name: string) => unknown;
type EnvSpec = Readonly<Record<string, readonly [string, EnvParser]>>;

const ENV_INTEGER = /^[+-]?\d+$/u;
const ENV_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/u;

function envBool(raw: string, name: string): boolean {
  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return fail(`${name} must be true/false, 1/0, yes/no, or on/off`);
  }
}

const envString: EnvParser = (raw) => raw;

function envInteger(raw: string, name: string): number {
  const trimmed = raw.trim();
  const parsed = ENV_INTEGER.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) fail(`${name} must be an integer`);
  return parsed;
}

function envNumber(raw: string, name: string): number {
  const trimmed = raw.trim();
  const parsed = ENV_NUMBER.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed)) fail(`${name} must be a number`);
  return parsed;
}

function parseJsonArray(raw: string, name: string): unknown[] {
  const decoded: unknown = (() => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return fail(`${name} must be a JSON array or a comma-separated list`);
    }
  })();
  if (!Array.isArray(decoded)) fail(`${name} must be a JSON array`);
  return decoded;
}

/** A JSON array (what flags-2-env emits for `type = "array"`) or a comma-separated list. */
function envArrayItems(raw: string, name: string): readonly unknown[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) return parseJsonArray(trimmed, name);
  const items = trimmed.split(',').map((item) => item.trim());
  if (items.some((item) => item === '')) fail(`${name} must not contain empty list entries`);
  return items;
}

const envStringArray: EnvParser = (raw, name) =>
  envArrayItems(raw, name).map((item) => (typeof item === 'string' ? item : fail(`${name} must contain strings`)));

const envNumberArray: EnvParser = (raw, name) =>
  envArrayItems(raw, name).map((item) => {
    if (typeof item === 'number') return item;
    return typeof item === 'string' ? envNumber(item, name) : fail(`${name} must contain numbers`);
  });

const envPropagators: EnvParser = (raw, name) => {
  const items = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
  return items.length > 0 ? items : fail(`${name} must be a comma-separated subset of tracecontext,baggage`);
};

function fromEnv(env: Readonly<Record<string, string>>, spec: EnvSpec): Plain {
  return Object.fromEntries(
    Object.entries(spec).flatMap(([key, [name, parse]]) => {
      const raw = env[name];
      return raw === undefined ? [] : [[key, parse(raw, name)]];
    }),
  );
}

function nonEmpty(groups: Readonly<Record<string, Plain>>): Plain {
  return Object.fromEntries(Object.entries(groups).filter(([, group]) => Object.keys(group).length > 0));
}

/** Returns `env` (undefined entries dropped) with `flagOverrides` applied on top. */
export function effectiveOresOtelEnv(
  env: OresOtelEnv,
  flagOverrides: OresOtelFlagOverrides = {},
): Readonly<Record<string, string>> {
  const defined = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return Object.freeze({ ...Object.fromEntries(defined), ...flagOverrides });
}

function envLayer(env: Readonly<Record<string, string>>): Plain {
  const raw = {
    ...fromEnv(env, {
      enabled: ['ORES_OTEL_ENABLED', envBool],
      service_name: ['ORES_OTEL_SERVICE_NAME', envString],
      environment: ['ORES_OTEL_ENVIRONMENT', envString],
    }),
    ...nonEmpty({
      logging: fromEnv(env, {
        enabled: ['ORES_OTEL_LOGGING_ENABLED', envBool],
        level: ['ORES_OTEL_LOG_LEVEL', envString],
        console: ['ORES_OTEL_LOG_CONSOLE', envBool],
        auto_send: ['ORES_OTEL_LOG_AUTO_SEND', envBool],
      }),
      tracing: fromEnv(env, {
        enabled: ['ORES_OTEL_TRACING_ENABLED', envBool],
        sample_ratio: ['ORES_OTEL_TRACE_SAMPLE_RATIO', envNumber],
        propagators: ['ORES_OTEL_PROPAGATORS', envPropagators],
      }),
      metrics: {
        ...fromEnv(env, { enabled: ['ORES_OTEL_METRICS_ENABLED', envBool] }),
        ...nonEmpty({
          process: fromEnv(env, {
            enabled: ['ORES_OTEL_METRICS_PROCESS_ENABLED', envBool],
            sample_interval_ms: ['ORES_OTEL_METRICS_SAMPLE_INTERVAL_MS', envInteger],
          }),
          filesystem: fromEnv(env, {
            enabled: ['ORES_OTEL_METRICS_FILESYSTEM_ENABLED', envBool],
            paths: ['ORES_OTEL_METRICS_FILESYSTEM_PATHS', envStringArray],
            min_free_bytes: ['ORES_OTEL_METRICS_MIN_FREE_BYTES', envInteger],
            min_free_ratio: ['ORES_OTEL_METRICS_MIN_FREE_RATIO', envNumber],
          }),
          latency: fromEnv(env, {
            enabled: ['ORES_OTEL_METRICS_LATENCY_ENABLED', envBool],
            histogram_boundaries_ms: ['ORES_OTEL_METRICS_HISTOGRAM_BOUNDARIES_MS', envNumberArray],
          }),
          runtime: fromEnv(env, { enabled: ['ORES_OTEL_METRICS_RUNTIME_ENABLED', envBool] }),
          saturation: fromEnv(env, {
            enabled: ['ORES_OTEL_METRICS_SATURATION_ENABLED', envBool],
            memory_ratio_warning: ['ORES_OTEL_METRICS_MEMORY_RATIO_WARNING', envNumber],
          }),
        }),
      },
      exporter: fromEnv(env, {
        protocol: ['ORES_OTEL_EXPORTER_PROTOCOL', envString],
        endpoint_env: ['ORES_OTEL_EXPORTER_ENDPOINT_ENV', envString],
      }),
    }),
  };
  try {
    return parseLayer(raw, 'env', NO_FLOATS);
  } catch (error) {
    if (error instanceof OresOtelConfigError) {
      fail(`ORES_OTEL_* environment/flag override rejected: ${error.message}`);
    }
    throw error;
  }
}

function requestedRole(
  env: Readonly<Record<string, string>>,
  explicit: OresOtelRuntimeRole | undefined,
): OresOtelRuntimeRole | undefined {
  if (explicit) return explicit;
  const raw = env.ORES_OTEL_ROLE?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (raw !== 'client' && raw !== 'server') fail('ORES_OTEL_ROLE must be client or server');
  return raw;
}

function selectRole(parsed: OresOtelFileConfigV1, requested: OresOtelRuntimeRole | undefined): OresOtelRole {
  const hasClient = parsed.client !== undefined;
  const hasServer = parsed.server !== undefined;
  if (requested === 'client' && !hasClient && hasServer) {
    fail('client telemetry role was requested but the file defines only a server role');
  }
  if (requested === 'server' && !hasServer && hasClient) {
    fail('server telemetry role was requested but the file defines only a client role');
  }
  if (requested) return requested;
  if (hasClient && hasServer) {
    fail('ambiguous .ores-otel.toml: both client and server sections exist; set ORES_OTEL_ROLE or pass role explicitly');
  }
  if (hasClient) return 'client';
  if (hasServer) return 'server';
  return 'shared';
}

const section = (source: Plain, key: string): Plain => {
  const value = source[key];
  return isPlain(value) ? value : {};
};
const flag = (source: Plain, key: string, fallback = true): unknown => source[key] ?? fallback;
const flags = (source: Plain, names: readonly string[]): Plain =>
  Object.fromEntries(names.map((name) => [name, flag(source, name)]));
const arrayOr = (value: unknown, fallback: readonly unknown[]): unknown[] => [
  ...(Array.isArray(value) ? (value as unknown[]) : fallback),
];

/** The snake_case resolved shape compared by the cross-language fixtures. */
function resolvedJson(role: OresOtelRole, layer: Plain): Plain {
  const logging = section(layer, 'logging');
  const tracing = section(layer, 'tracing');
  const metrics = section(layer, 'metrics');
  const exporter = section(layer, 'exporter');
  const filesystem = section(metrics, 'filesystem');
  const latency = section(metrics, 'latency');
  const saturation = section(metrics, 'saturation');
  const processMetrics = section(metrics, 'process');
  return compact({
    version: ORES_OTEL_CONFIG_VERSION,
    role,
    enabled: flag(layer, 'enabled'),
    service_name: layer.service_name,
    environment: layer.environment,
    logging: {
      enabled: flag(logging, 'enabled'),
      level: logging.level ?? 'info',
      console: flag(logging, 'console'),
      auto_send: flag(logging, 'auto_send', false),
    },
    tracing: {
      enabled: flag(tracing, 'enabled'),
      sample_ratio: tracing.sample_ratio ?? 1,
      propagators: arrayOr(tracing.propagators, ['tracecontext', 'baggage']),
    },
    metrics: {
      enabled: flag(metrics, 'enabled'),
      process: { ...flags(processMetrics, PROCESS_BOOLS), sample_interval_ms: processMetrics.sample_interval_ms ?? 10_000 },
      filesystem: compact({
        ...flags(filesystem, FILESYSTEM_BOOLS),
        paths: arrayOr(filesystem.paths, ['.']),
        min_free_bytes: filesystem.min_free_bytes,
        min_free_ratio: filesystem.min_free_ratio,
        min_inode_free_ratio: filesystem.min_inode_free_ratio,
      }),
      latency: {
        ...flags(latency, LATENCY_BOOLS),
        histogram_boundaries_ms: arrayOr(latency.histogram_boundaries_ms, ORES_OTEL_DEFAULT_HISTOGRAM_BOUNDARIES_MS),
      },
      runtime: flags(section(metrics, 'runtime'), RUNTIME_BOOLS),
      saturation: compact({
        enabled: flag(saturation, 'enabled'),
        ...Object.fromEntries(SATURATION_RATIOS.map((name) => [name, saturation[name]])),
        queue_depth_warning: saturation.queue_depth_warning,
      }),
      exemplars: flag(metrics, 'exemplars', false),
      span_metrics: flag(metrics, 'span_metrics', false),
      service_graphs: flag(metrics, 'service_graphs', false),
    },
    exporter: compact({ protocol: exporter.protocol ?? 'none', endpoint_env: exporter.endpoint_env }),
  });
}

/** Applies defaults < common < selected role < env < flagOverrides < explicit overrides. */
export function resolveOresOtelConfig(
  parsed: OresOtelFileConfigV1,
  options: ResolveOresOtelConfigOptions = {},
): ResolvedOresOtelConfig {
  const env = effectiveOresOtelEnv(options.env ?? process.env, options.flagOverrides);
  const role = selectRole(parsed, requestedRole(env, options.role));
  const fileLayer = (layer: OresOtelFileLayer | undefined): Plain[] =>
    layer === undefined ? [] : [layer as unknown as Plain];
  const layers: Plain[] = [
    ...fileLayer(parsed.common),
    ...fileLayer(role === 'client' ? parsed.client : undefined),
    ...fileLayer(role === 'server' ? parsed.server : undefined),
    envLayer(env),
    ...(options.overrides === undefined
      ? []
      : [parseLayer(mapKeys(options.overrides, toSnake), 'overrides', NO_FLOATS)]),
  ];
  const merged = layers.reduce((base, overlay) => merge(base, overlay), {});
  return deepFreeze(mapKeys(resolvedJson(role, merged), toCamel) as ResolvedOresOtelConfig);
}

/** Renders a resolved config as the snake_case object the parity fixtures compare. */
export function oresOtelConfigToJson(config: ResolvedOresOtelConfig): Record<string, unknown> {
  return mapKeys(config, toSnake) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

export interface OresOtelConfigFilePathOptions {
  cwd?: string | undefined;
  filePath?: string | undefined;
  /** Environment with flag overrides already applied (see {@link effectiveOresOtelEnv}). */
  env: Readonly<Record<string, string | undefined>>;
  currentDirectory: string;
}

/**
 * Picks the config file path. Precedence: `filePath`, `cwd`,
 * `ORES_OTEL_CONFIG_FILE`, `ORES_OTEL_CONFIG_DIR`, then `currentDirectory`.
 * Blank values are skipped; directory trailing separators are stripped.
 */
export function oresOtelConfigFilePath(options: OresOtelConfigFilePathOptions): string {
  const nonBlank = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value.trim();
  const inDirectory = (directory: string): string =>
    `${directory.replace(/[\\/]+$/u, '')}/${ORES_OTEL_CONFIG_BASENAME}`;
  const explicitFile = nonBlank(options.filePath);
  const cwd = nonBlank(options.cwd);
  const envFile = nonBlank(options.env.ORES_OTEL_CONFIG_FILE);
  if (explicitFile !== undefined) return explicitFile;
  if (cwd !== undefined) return inDirectory(cwd);
  if (envFile !== undefined) return envFile;
  return inDirectory(nonBlank(options.env.ORES_OTEL_CONFIG_DIR) ?? options.currentDirectory);
}

function isMissingFileError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/** Reads `.ores-otel.toml` when present, then resolves its runtime role and overrides. */
export async function loadOresOtelConfig(
  options: LoadOresOtelConfigOptions = {},
): Promise<LoadedOresOtelConfig> {
  const env = options.env ?? process.env;
  const resolveOptions: ResolveOresOtelConfigOptions = { ...options, env };
  const filePath = oresOtelConfigFilePath({
    cwd: options.cwd,
    filePath: options.filePath,
    env: effectiveOresOtelEnv(env, options.flagOverrides),
    currentDirectory: process.cwd(),
  });
  const input = await readFile(filePath, 'utf8').catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (input === null) {
    const parsed: OresOtelFileConfigV1 = Object.freeze({ version: ORES_OTEL_CONFIG_VERSION });
    return { parsed, config: resolveOresOtelConfig(parsed, resolveOptions), filePath: null };
  }
  const parsed = parseOresOtelToml(input);
  return { parsed, config: resolveOresOtelConfig(parsed, resolveOptions), filePath };
}

/** Returns the endpoint from the selected environment variable without persisting or logging it. */
export function resolveOresOtelExporterEndpoint(
  config: ResolvedOresOtelConfig,
  env: OresOtelEnv = process.env,
): string | undefined {
  if (!config.exporter.endpointEnv) return undefined;
  const value = env[config.exporter.endpointEnv]?.trim();
  return value || undefined;
}

export function oresOtelConfigToLoggerOptions(config: ResolvedOresOtelConfig): LoggerOptions {
  const upper = config.logging.level.toUpperCase() as LogLevel;
  return {
    ...(config.serviceName === undefined ? {} : { appName: config.serviceName }),
    maxLevel: upper,
    console: config.enabled && config.logging.enabled ? config.logging.console : false,
    autoSend: config.enabled && config.logging.enabled ? config.logging.autoSend : false,
  };
}

/** Builds a logger from `.ores-otel.toml`; explicit logger options remain the final override. */
export async function createLoggerFromOresOtelConfig(
  loggerOverrides: LoggerOptions = {},
  loadOptions: LoadOresOtelConfigOptions = {},
): Promise<BaseLogger> {
  const loaded = await loadOresOtelConfig(loadOptions);
  return createLogger({ ...oresOtelConfigToLoggerOptions(loaded.config), ...loggerOverrides });
}
