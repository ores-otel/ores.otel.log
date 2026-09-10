import { readFile } from 'node:fs/promises';
import {
  createLogger,
  LOG_LEVELS,
  type BaseLogger,
  type LoggerOptions,
  type LogLevel,
} from './base-logger.js';
import { parseToml, type TomlTable, type TomlValue } from './cli/toml.js';

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

export interface OresOtelFileMetricsConfig {
  enabled?: boolean;
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

export interface OresOtelMetricsConfig {
  enabled: boolean;
}

export interface OresOtelExporterConfig {
  protocol: OresOtelExporterProtocol;
  /** Name of the environment variable containing the actual exporter endpoint. */
  endpointEnv?: string;
}

export interface OresOtelLayer {
  enabled?: boolean;
  serviceName?: string;
  environment?: string;
  logging?: Partial<OresOtelLoggingConfig>;
  tracing?: Partial<OresOtelTracingConfig>;
  metrics?: Partial<OresOtelMetricsConfig>;
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

export interface ResolveOresOtelConfigOptions {
  env?: OresOtelEnv;
  role?: OresOtelRuntimeRole;
  overrides?: OresOtelLayer;
}

export interface LoadOresOtelConfigOptions extends ResolveOresOtelConfigOptions {
  /** Root directory containing `.ores-otel.toml`; defaults to ORES_OTEL_CONFIG_DIR, then cwd. */
  cwd?: string;
  /** Explicit config file path. This outranks cwd/config-dir discovery. */
  filePath?: string;
}

export interface LoadedOresOtelConfig {
  config: ResolvedOresOtelConfig;
  parsed: OresOtelFileConfigV1;
  filePath: string | null;
}

const ROOT_KEYS = new Set(['version', 'common', 'client', 'server']);
const LAYER_KEYS = new Set([
  'enabled',
  'service_name',
  'environment',
  'logging',
  'tracing',
  'metrics',
  'exporter',
]);
const LOGGING_KEYS = new Set(['enabled', 'level', 'console', 'auto_send']);
const TRACING_KEYS = new Set(['enabled', 'sample_ratio', 'propagators']);
const METRICS_KEYS = new Set(['enabled']);
const EXPORTER_KEYS = new Set(['protocol', 'endpoint_env']);
const LOG_LEVELS_LOWER = new Set<OresOtelLogLevel>(
  LOG_LEVELS.map((value) => value.toLowerCase() as OresOtelLogLevel),
);
const EXPORTER_PROTOCOLS = new Set<OresOtelExporterProtocol>(['none', 'otlp_http', 'otlp_grpc']);
const PROPAGATORS = new Set<OresOtelPropagator>(['tracecontext', 'baggage']);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SENSITIVE_KEY = /(?:authorization|token|secret|password|cookie|api[_-]?key|private[_-]?key|headers?)/iu;

const DEFAULT_CONFIG: ResolvedOresOtelConfig = Object.freeze({
  version: 1,
  role: 'shared',
  enabled: true,
  logging: Object.freeze({
    enabled: true,
    level: 'info',
    console: true,
    autoSend: false,
  }),
  tracing: Object.freeze({
    enabled: true,
    sampleRatio: 1,
    propagators: Object.freeze(['tracecontext', 'baggage']) as unknown as OresOtelPropagator[],
  }),
  metrics: Object.freeze({ enabled: true }),
  exporter: Object.freeze({ protocol: 'none' }),
});

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(table: TomlTable, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(table)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new Error(`${path}.${key} is forbidden: credentials and secret-shaped settings do not belong in .ores-otel.toml`);
    }
    if (!allowed.has(key)) {
      throw new Error(`${path}.${key} is not a supported .ores-otel.toml v1 key`);
    }
  }
}

function optionalTable(table: TomlTable, key: string, path: string): TomlTable | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (!isTable(value)) throw new TypeError(`${path}.${key} must be a TOML table`);
  return value;
}

function optionalBoolean(table: TomlTable, key: string, path: string): boolean | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${path}.${key} must be a boolean`);
  return value;
}

function optionalString(
  table: TomlTable,
  key: string,
  path: string,
  maximum: number,
): string | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${path}.${key} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new RangeError(`${path}.${key} must contain 1..${maximum} non-whitespace characters`);
  }
  return normalized;
}

function optionalNumber(table: TomlTable, key: string, path: string): number | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${path}.${key} must be a finite number`);
  }
  return value;
}

function optionalStringArray(table: TomlTable, key: string, path: string): string[] | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${path}.${key} must be an array of strings`);
  }
  return [...value];
}

function parseLogging(table: TomlTable | undefined, path: string): OresOtelFileLoggingConfig | undefined {
  if (!table) return undefined;
  assertAllowedKeys(table, LOGGING_KEYS, path);
  const enabled = optionalBoolean(table, 'enabled', path);
  const level = optionalString(table, 'level', path, 16);
  const console = optionalBoolean(table, 'console', path);
  const autoSend = optionalBoolean(table, 'auto_send', path);
  if (level !== undefined && !LOG_LEVELS_LOWER.has(level.toLowerCase() as OresOtelLogLevel)) {
    throw new RangeError(`${path}.level must be trace|debug|info|warn|error|fatal`);
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(level === undefined ? {} : { level: level.toLowerCase() }),
    ...(console === undefined ? {} : { console }),
    ...(autoSend === undefined ? {} : { auto_send: autoSend }),
  };
}

function parseTracing(table: TomlTable | undefined, path: string): OresOtelFileTracingConfig | undefined {
  if (!table) return undefined;
  assertAllowedKeys(table, TRACING_KEYS, path);
  const sampleRatio = optionalNumber(table, 'sample_ratio', path);
  if (sampleRatio !== undefined && (sampleRatio < 0 || sampleRatio > 1)) {
    throw new RangeError(`${path}.sample_ratio must be between 0 and 1 inclusive`);
  }
  const propagators = optionalStringArray(table, 'propagators', path)?.map((value) => value.trim().toLowerCase());
  if (propagators) {
    if (propagators.length > 8) throw new RangeError(`${path}.propagators may contain at most 8 entries`);
    const seen = new Set<string>();
    for (const value of propagators) {
      if (!PROPAGATORS.has(value as OresOtelPropagator)) {
        throw new RangeError(`${path}.propagators contains unsupported value ${value}`);
      }
      if (seen.has(value)) throw new RangeError(`${path}.propagators must not contain duplicates`);
      seen.add(value);
    }
  }
  const enabled = optionalBoolean(table, 'enabled', path);
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(sampleRatio === undefined ? {} : { sample_ratio: sampleRatio }),
    ...(propagators === undefined ? {} : { propagators }),
  };
}

function parseMetrics(table: TomlTable | undefined, path: string): OresOtelFileMetricsConfig | undefined {
  if (!table) return undefined;
  assertAllowedKeys(table, METRICS_KEYS, path);
  const enabled = optionalBoolean(table, 'enabled', path);
  return enabled === undefined ? {} : { enabled };
}

function parseExporter(table: TomlTable | undefined, path: string): OresOtelFileExporterConfig | undefined {
  if (!table) return undefined;
  assertAllowedKeys(table, EXPORTER_KEYS, path);
  const protocol = optionalString(table, 'protocol', path, 32)?.toLowerCase();
  if (protocol !== undefined && !EXPORTER_PROTOCOLS.has(protocol as OresOtelExporterProtocol)) {
    throw new RangeError(`${path}.protocol must be none|otlp_http|otlp_grpc`);
  }
  const endpointEnv = optionalString(table, 'endpoint_env', path, 128);
  if (endpointEnv !== undefined && !ENV_NAME.test(endpointEnv)) {
    throw new RangeError(`${path}.endpoint_env must be an uppercase environment-variable name`);
  }
  return {
    ...(protocol === undefined ? {} : { protocol }),
    ...(endpointEnv === undefined ? {} : { endpoint_env: endpointEnv }),
  };
}

function parseLayer(table: TomlTable, path: string): OresOtelFileLayer {
  assertAllowedKeys(table, LAYER_KEYS, path);
  const enabled = optionalBoolean(table, 'enabled', path);
  const serviceName = optionalString(table, 'service_name', path, 256);
  const environment = optionalString(table, 'environment', path, 128);
  const logging = parseLogging(optionalTable(table, 'logging', path), `${path}.logging`);
  const tracing = parseTracing(optionalTable(table, 'tracing', path), `${path}.tracing`);
  const metrics = parseMetrics(optionalTable(table, 'metrics', path), `${path}.metrics`);
  const exporter = parseExporter(optionalTable(table, 'exporter', path), `${path}.exporter`);
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(serviceName === undefined ? {} : { service_name: serviceName }),
    ...(environment === undefined ? {} : { environment }),
    ...(logging === undefined ? {} : { logging }),
    ...(tracing === undefined ? {} : { tracing }),
    ...(metrics === undefined ? {} : { metrics }),
    ...(exporter === undefined ? {} : { exporter }),
  };
}

/** Strictly parses the tracked TOML file and applies runtime-only semantic checks. */
export function parseOresOtelToml(input: string): OresOtelFileConfigV1 {
  const table = parseToml(input);
  assertAllowedKeys(table, ROOT_KEYS, 'root');
  if (table.version !== ORES_OTEL_CONFIG_VERSION) {
    throw new RangeError(`root.version must equal ${ORES_OTEL_CONFIG_VERSION}`);
  }
  const common = optionalTable(table, 'common', 'root');
  const client = optionalTable(table, 'client', 'root');
  const server = optionalTable(table, 'server', 'root');
  return {
    version: 1,
    ...(common === undefined ? {} : { common: parseLayer(common, 'common') }),
    ...(client === undefined ? {} : { client: parseLayer(client, 'client') }),
    ...(server === undefined ? {} : { server: parseLayer(server, 'server') }),
  };
}

function fileLayerToRuntime(layer: OresOtelFileLayer | undefined): OresOtelLayer {
  if (!layer) return {};
  return {
    ...(layer.enabled === undefined ? {} : { enabled: layer.enabled }),
    ...(layer.service_name === undefined ? {} : { serviceName: layer.service_name }),
    ...(layer.environment === undefined ? {} : { environment: layer.environment }),
    ...(layer.logging === undefined
      ? {}
      : {
          logging: {
            ...(layer.logging.enabled === undefined ? {} : { enabled: layer.logging.enabled }),
            ...(layer.logging.level === undefined
              ? {}
              : { level: layer.logging.level as OresOtelLogLevel }),
            ...(layer.logging.console === undefined ? {} : { console: layer.logging.console }),
            ...(layer.logging.auto_send === undefined ? {} : { autoSend: layer.logging.auto_send }),
          },
        }),
    ...(layer.tracing === undefined
      ? {}
      : {
          tracing: {
            ...(layer.tracing.enabled === undefined ? {} : { enabled: layer.tracing.enabled }),
            ...(layer.tracing.sample_ratio === undefined ? {} : { sampleRatio: layer.tracing.sample_ratio }),
            ...(layer.tracing.propagators === undefined
              ? {}
              : { propagators: layer.tracing.propagators as OresOtelPropagator[] }),
          },
        }),
    ...(layer.metrics === undefined
      ? {}
      : { metrics: layer.metrics.enabled === undefined ? {} : { enabled: layer.metrics.enabled } }),
    ...(layer.exporter === undefined
      ? {}
      : {
          exporter: {
            ...(layer.exporter.protocol === undefined
              ? {}
              : { protocol: layer.exporter.protocol as OresOtelExporterProtocol }),
            ...(layer.exporter.endpoint_env === undefined ? {} : { endpointEnv: layer.exporter.endpoint_env }),
          },
        }),
  };
}

function mergeLayer(base: OresOtelLayer, overlay: OresOtelLayer): OresOtelLayer {
  return {
    ...base,
    ...overlay,
    ...(base.logging || overlay.logging ? { logging: { ...base.logging, ...overlay.logging } } : {}),
    ...(base.tracing || overlay.tracing ? { tracing: { ...base.tracing, ...overlay.tracing } } : {}),
    ...(base.metrics || overlay.metrics ? { metrics: { ...base.metrics, ...overlay.metrics } } : {}),
    ...(base.exporter || overlay.exporter ? { exporter: { ...base.exporter, ...overlay.exporter } } : {}),
  };
}

function parseBooleanEnv(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  switch (value.trim().toLowerCase()) {
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
      throw new Error(`${name} must be true/false, 1/0, yes/no, or on/off`);
  }
}

function envLayer(env: OresOtelEnv): OresOtelLayer {
  const enabled = parseBooleanEnv(env.ORES_OTEL_ENABLED, 'ORES_OTEL_ENABLED');
  const loggingEnabled = parseBooleanEnv(env.ORES_OTEL_LOGGING_ENABLED, 'ORES_OTEL_LOGGING_ENABLED');
  const logConsole = parseBooleanEnv(env.ORES_OTEL_LOG_CONSOLE, 'ORES_OTEL_LOG_CONSOLE');
  const autoSend = parseBooleanEnv(env.ORES_OTEL_LOG_AUTO_SEND, 'ORES_OTEL_LOG_AUTO_SEND');
  const tracingEnabled = parseBooleanEnv(env.ORES_OTEL_TRACING_ENABLED, 'ORES_OTEL_TRACING_ENABLED');
  const metricsEnabled = parseBooleanEnv(env.ORES_OTEL_METRICS_ENABLED, 'ORES_OTEL_METRICS_ENABLED');

  let level: OresOtelLogLevel | undefined;
  if (env.ORES_OTEL_LOG_LEVEL !== undefined) {
    const candidate = env.ORES_OTEL_LOG_LEVEL.trim().toLowerCase() as OresOtelLogLevel;
    if (!LOG_LEVELS_LOWER.has(candidate)) throw new Error('ORES_OTEL_LOG_LEVEL must be trace|debug|info|warn|error|fatal');
    level = candidate;
  }

  let sampleRatio: number | undefined;
  if (env.ORES_OTEL_TRACE_SAMPLE_RATIO !== undefined) {
    sampleRatio = Number(env.ORES_OTEL_TRACE_SAMPLE_RATIO);
    if (!Number.isFinite(sampleRatio) || sampleRatio < 0 || sampleRatio > 1) {
      throw new Error('ORES_OTEL_TRACE_SAMPLE_RATIO must be a finite number between 0 and 1');
    }
  }

  let propagators: OresOtelPropagator[] | undefined;
  if (env.ORES_OTEL_PROPAGATORS !== undefined) {
    propagators = env.ORES_OTEL_PROPAGATORS.split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean) as OresOtelPropagator[];
    if (propagators.length === 0 || propagators.some((value) => !PROPAGATORS.has(value))) {
      throw new Error('ORES_OTEL_PROPAGATORS must be a comma-separated subset of tracecontext,baggage');
    }
    if (new Set(propagators).size !== propagators.length) {
      throw new Error('ORES_OTEL_PROPAGATORS must not contain duplicates');
    }
  }

  let protocol: OresOtelExporterProtocol | undefined;
  if (env.ORES_OTEL_EXPORTER_PROTOCOL !== undefined) {
    const candidate = env.ORES_OTEL_EXPORTER_PROTOCOL.trim().toLowerCase() as OresOtelExporterProtocol;
    if (!EXPORTER_PROTOCOLS.has(candidate)) throw new Error('ORES_OTEL_EXPORTER_PROTOCOL must be none|otlp_http|otlp_grpc');
    protocol = candidate;
  }

  let endpointEnv: string | undefined;
  if (env.ORES_OTEL_EXPORTER_ENDPOINT_ENV !== undefined) {
    endpointEnv = env.ORES_OTEL_EXPORTER_ENDPOINT_ENV.trim();
    if (!ENV_NAME.test(endpointEnv)) {
      throw new Error('ORES_OTEL_EXPORTER_ENDPOINT_ENV must name an uppercase environment variable');
    }
  }

  const serviceName = env.ORES_OTEL_SERVICE_NAME?.trim();
  if (serviceName !== undefined && (serviceName.length === 0 || serviceName.length > 256)) {
    throw new Error('ORES_OTEL_SERVICE_NAME must contain 1..256 characters');
  }
  const environment = env.ORES_OTEL_ENVIRONMENT?.trim();
  if (environment !== undefined && (environment.length === 0 || environment.length > 128)) {
    throw new Error('ORES_OTEL_ENVIRONMENT must contain 1..128 characters');
  }

  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(environment === undefined ? {} : { environment }),
    ...(loggingEnabled === undefined && level === undefined && logConsole === undefined && autoSend === undefined
      ? {}
      : {
          logging: {
            ...(loggingEnabled === undefined ? {} : { enabled: loggingEnabled }),
            ...(level === undefined ? {} : { level }),
            ...(logConsole === undefined ? {} : { console: logConsole }),
            ...(autoSend === undefined ? {} : { autoSend }),
          },
        }),
    ...(tracingEnabled === undefined && sampleRatio === undefined && propagators === undefined
      ? {}
      : {
          tracing: {
            ...(tracingEnabled === undefined ? {} : { enabled: tracingEnabled }),
            ...(sampleRatio === undefined ? {} : { sampleRatio }),
            ...(propagators === undefined ? {} : { propagators }),
          },
        }),
    ...(metricsEnabled === undefined ? {} : { metrics: { enabled: metricsEnabled } }),
    ...(protocol === undefined && endpointEnv === undefined
      ? {}
      : {
          exporter: {
            ...(protocol === undefined ? {} : { protocol }),
            ...(endpointEnv === undefined ? {} : { endpointEnv }),
          },
        }),
  };
}

function requestedRole(env: OresOtelEnv, explicit: OresOtelRuntimeRole | undefined): OresOtelRuntimeRole | undefined {
  if (explicit) return explicit;
  const raw = env.ORES_OTEL_ROLE?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (raw !== 'client' && raw !== 'server') {
    throw new Error('ORES_OTEL_ROLE must be client or server');
  }
  return raw;
}

function selectRole(parsed: OresOtelFileConfigV1, requested: OresOtelRuntimeRole | undefined): OresOtelRole {
  const hasClient = parsed.client !== undefined;
  const hasServer = parsed.server !== undefined;
  if (requested) {
    if (requested === 'client' && !hasClient && hasServer) {
      throw new Error('client telemetry role was requested but the file defines only a server role');
    }
    if (requested === 'server' && !hasServer && hasClient) {
      throw new Error('server telemetry role was requested but the file defines only a client role');
    }
    return requested;
  }
  if (hasClient && hasServer) {
    throw new Error('ambiguous .ores-otel.toml: both client and server sections exist; set ORES_OTEL_ROLE or pass role explicitly');
  }
  if (hasClient) return 'client';
  if (hasServer) return 'server';
  return 'shared';
}

/** Applies defaults < common < selected role < environment < explicit overrides. */
export function resolveOresOtelConfig(
  parsed: OresOtelFileConfigV1,
  options: ResolveOresOtelConfigOptions = {},
): ResolvedOresOtelConfig {
  const env = options.env ?? process.env;
  const role = selectRole(parsed, requestedRole(env, options.role));
  let layer: OresOtelLayer = fileLayerToRuntime(parsed.common);
  if (role === 'client') layer = mergeLayer(layer, fileLayerToRuntime(parsed.client));
  if (role === 'server') layer = mergeLayer(layer, fileLayerToRuntime(parsed.server));
  layer = mergeLayer(layer, envLayer(env));
  layer = mergeLayer(layer, options.overrides ?? {});

  return {
    version: 1,
    role,
    enabled: layer.enabled ?? DEFAULT_CONFIG.enabled,
    ...(layer.serviceName === undefined ? {} : { serviceName: layer.serviceName }),
    ...(layer.environment === undefined ? {} : { environment: layer.environment }),
    logging: {
      enabled: layer.logging?.enabled ?? DEFAULT_CONFIG.logging.enabled,
      level: layer.logging?.level ?? DEFAULT_CONFIG.logging.level,
      console: layer.logging?.console ?? DEFAULT_CONFIG.logging.console,
      autoSend: layer.logging?.autoSend ?? DEFAULT_CONFIG.logging.autoSend,
    },
    tracing: {
      enabled: layer.tracing?.enabled ?? DEFAULT_CONFIG.tracing.enabled,
      sampleRatio: layer.tracing?.sampleRatio ?? DEFAULT_CONFIG.tracing.sampleRatio,
      propagators: [...(layer.tracing?.propagators ?? DEFAULT_CONFIG.tracing.propagators)],
    },
    metrics: {
      enabled: layer.metrics?.enabled ?? DEFAULT_CONFIG.metrics.enabled,
    },
    exporter: {
      protocol: layer.exporter?.protocol ?? DEFAULT_CONFIG.exporter.protocol,
      ...(layer.exporter?.endpointEnv === undefined ? {} : { endpointEnv: layer.exporter.endpointEnv }),
    },
  };
}

function isMissingFileError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/** Reads the repository-root file when present, then resolves its runtime role and overrides. */
export async function loadOresOtelConfig(
  options: LoadOresOtelConfigOptions = {},
): Promise<LoadedOresOtelConfig> {
  const env = options.env ?? process.env;
  const root = (options.cwd ?? env.ORES_OTEL_CONFIG_DIR ?? process.cwd()).replace(/[\\/]$/u, '');
  const filePath = options.filePath ?? `${root}/${ORES_OTEL_CONFIG_BASENAME}`;
  let input: string;
  try {
    input = await readFile(filePath, 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    const parsed: OresOtelFileConfigV1 = { version: 1 };
    return {
      parsed,
      config: resolveOresOtelConfig(parsed, options),
      filePath: null,
    };
  }
  const parsed = parseOresOtelToml(input);
  return {
    parsed,
    config: resolveOresOtelConfig(parsed, options),
    filePath,
  };
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
