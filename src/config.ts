import {
  createLogger,
  LOG_LEVELS,
  type BaseLogger,
  type ErrorTrackingOptions,
  type LoggerOptions,
  type LogLevel,
} from './base-logger.js';

// Server-side module (Node, Bun, Deno): a minimal process declaration keeps
// this package free of @types/node, matching node-logger.ts.
declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};

export type ConfigEnv = Record<string, string | undefined>;

/**
 * Shape of the project-root `.next-logger.ts` config file: default-export
 * either LoggerOptions or a (sync or async) function of the environment.
 * Because the file is code, it can read env vars, branch per deployment, and
 * even construct transports directly.
 */
export type NextLoggerConfig =
  | LoggerOptions
  | ((env: ConfigEnv) => LoggerOptions | Promise<LoggerOptions>);

/** Checked in order; the first file that loads wins. */
export const CONFIG_BASENAMES = [
  '.next-logger.ts',
  '.next-logger.mts',
  '.next-logger.mjs',
  '.next-logger.js',
] as const;

export interface LoadConfigOptions {
  /** Directory holding the config file; defaults to NEXT_LOGGER_CONFIG_DIR, then process.cwd(). */
  cwd?: string;
  /** Environment map consulted for overrides; defaults to process.env. */
  env?: ConfigEnv;
}

export interface LoadedNextLoggerConfig {
  options: LoggerOptions;
  /** Absolute path of the config file that loaded, or null when none was found. */
  filePath: string | null;
}

function toFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${encodeURI(prefixed).replace(/[?#]/g, (match) => (match === '?' ? '%3F' : '%23'))}`;
}

function isFlagEnabled(value: string): boolean {
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function parseLevel(value: string): LogLevel | undefined {
  const upper = value.trim().toUpperCase() as LogLevel;
  return (LOG_LEVELS as readonly string[]).includes(upper) ? upper : undefined;
}

/**
 * Environment-variable overrides, applied on top of the config file. The names
 * pair with CLI flags via flags-2-env (github.com/oresoftware/flags-2-env):
 * `--next-logger-app-name=x` becomes NEXT_LOGGER_APP_NAME=x, which lands here.
 */
export function envToLoggerOptions(env: ConfigEnv): LoggerOptions {
  const options: LoggerOptions = {};
  if (env.NEXT_LOGGER_APP_NAME) {
    options.appName = env.NEXT_LOGGER_APP_NAME;
  }
  if (env.NEXT_LOGGER_NAME) {
    options.name = env.NEXT_LOGGER_NAME;
  }
  if (env.NEXT_LOGGER_MAX_LEVEL) {
    const level = parseLevel(env.NEXT_LOGGER_MAX_LEVEL);
    if (level) {
      options.maxLevel = level;
    }
  }
  if (env.NEXT_LOGGER_CONSOLE !== undefined) {
    options.console = isFlagEnabled(env.NEXT_LOGGER_CONSOLE);
  }
  if (env.NEXT_LOGGER_AUTO_SEND !== undefined) {
    options.autoSend = isFlagEnabled(env.NEXT_LOGGER_AUTO_SEND);
  }
  if (env.NEXT_LOGGER_HTTP_ENDPOINT) {
    options.http = {
      endpoint: env.NEXT_LOGGER_HTTP_ENDPOINT,
      ...(env.NEXT_LOGGER_HTTP_FALLBACK_ENDPOINT
        ? { fallbackEndpoint: env.NEXT_LOGGER_HTTP_FALLBACK_ENDPOINT }
        : {}),
    };
  }
  if (env.NEXT_LOGGER_ERROR_TRACKING_URL) {
    const errorTracking: ErrorTrackingOptions = { url: env.NEXT_LOGGER_ERROR_TRACKING_URL };
    if (env.NEXT_LOGGER_ERROR_TRACKING_FALLBACK_URL) {
      errorTracking.fallbackUrl = env.NEXT_LOGGER_ERROR_TRACKING_FALLBACK_URL;
    }
    if (env.NEXT_LOGGER_ERROR_TRACKING_MIN_LEVEL) {
      const level = parseLevel(env.NEXT_LOGGER_ERROR_TRACKING_MIN_LEVEL);
      if (level) {
        errorTracking.minLevel = level;
      }
    }
    options.errorTracking = errorTracking;
  }
  if (env.NEXT_LOGGER_SUPABASE_URL && env.NEXT_LOGGER_SUPABASE_ANON_KEY) {
    options.supabase = {
      url: env.NEXT_LOGGER_SUPABASE_URL,
      anonKey: env.NEXT_LOGGER_SUPABASE_ANON_KEY,
      ...(env.NEXT_LOGGER_SUPABASE_CHANNEL
        ? { channel: env.NEXT_LOGGER_SUPABASE_CHANNEL }
        : {}),
      ...(env.NEXT_LOGGER_SUPABASE_EVENT ? { event: env.NEXT_LOGGER_SUPABASE_EVENT } : {}),
    };
  }
  return options;
}

function isMissingModuleError(error: unknown, candidatePath: string): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    return false;
  }
  // A config file that itself imports a missing module raises the same code;
  // only treat the error as "no config file" when the module that could not be
  // found IS the candidate (not merely mentioned as the importing file).
  // Node says `Cannot find module '...'`; Deno says `Module not found "..."`.
  const message = String((error as Error).message ?? '');
  const quoted =
    /Cannot find (?:module|package) '([^']+)'/.exec(message)?.[1] ??
    /[Mm]odule not found\s+"([^"]+)"/.exec(message)?.[1];
  if (!quoted) {
    return message.includes(candidatePath) || message.includes(toFileUrl(candidatePath));
  }
  return quoted === candidatePath || quoted === toFileUrl(candidatePath);
}

function isUnsupportedTypeScriptError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ERR_UNKNOWN_FILE_EXTENSION' || code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING';
}

type ConfigModule = { default?: NextLoggerConfig; config?: NextLoggerConfig };

/** Imports one candidate config module; `undefined` means the file does not exist. */
async function importConfigModule(candidate: string): Promise<ConfigModule | undefined> {
  try {
    return (await import(/* webpackIgnore: true */ toFileUrl(candidate))) as ConfigModule;
  } catch (error) {
    if (isMissingModuleError(error, candidate)) {
      return undefined;
    }
    if (isUnsupportedTypeScriptError(error)) {
      throw new Error(
        `${candidate} exists but this runtime cannot import TypeScript directly. ` +
          'Use Node >= 22.18 (native type stripping), Bun, or Deno — or rename the config to .next-logger.mjs.',
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * The options exported by the first config file that exists under `root`, and
 * its path; empty options and a null path when none does. Candidates are tried
 * in CONFIG_BASENAMES order and the result is returned, never accumulated.
 */
async function loadConfigFile(
  root: string,
  env: ConfigEnv,
): Promise<{ options: LoggerOptions; filePath: string | null }> {
  for (const basename of CONFIG_BASENAMES) {
    const candidate = `${root}/${basename}`;
    const moduleNamespace = await importConfigModule(candidate);
    if (moduleNamespace === undefined) {
      continue;
    }
    const exported = moduleNamespace.default ?? moduleNamespace.config;
    if (exported === undefined) {
      throw new Error(`${candidate} must default-export LoggerOptions or a function returning them`);
    }
    return {
      options: typeof exported === 'function' ? await exported(env) : exported,
      filePath: candidate,
    };
  }
  return { options: {}, filePath: null };
}

/**
 * Loads `.next-logger.ts` (or .mts/.mjs/.js) from the project root and merges
 * NEXT_LOGGER_* env overrides on top. TypeScript configs load natively on
 * Bun, Deno, and Node with type stripping (22.18+); on older Node, a clear
 * error tells the user to use a supported runtime or a .mjs config.
 */
export async function loadNextLoggerConfig(
  loadOptions: LoadConfigOptions = {},
): Promise<LoadedNextLoggerConfig> {
  const env = loadOptions.env ?? process.env;
  const root = (loadOptions.cwd ?? env.NEXT_LOGGER_CONFIG_DIR ?? process.cwd()).replace(/\/$/, '');

  const { options: fileOptions, filePath } = await loadConfigFile(root, env);
  const envOptions = envToLoggerOptions(env);
  return {
    options: {
      ...fileOptions,
      ...envOptions,
      ...(fileOptions.fields || envOptions.fields
        ? { fields: { ...fileOptions.fields, ...envOptions.fields } }
        : {}),
    },
    filePath,
  };
}

/** Loads the project config file and returns a logger built from it plus any inline overrides. */
export async function createLoggerFromConfig(
  overrides: LoggerOptions = {},
  loadOptions: LoadConfigOptions = {},
): Promise<BaseLogger> {
  const { options } = await loadNextLoggerConfig(loadOptions);
  return createLogger({ ...options, ...overrides });
}

// `.ores-otel.toml` is the language-neutral telemetry policy surface. The
// legacy executable `.next-logger.*` config remains supported for compatibility.
export * from './ores-otel-config.js';
