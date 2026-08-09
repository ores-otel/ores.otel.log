/**
 * The CLI's flag/command declaration — the runtime source of truth.
 *
 * `.cli-flags.toml` at the repo root declares the same contract in the
 * portable flags-2-env format. The two are asserted equal, in both directions,
 * by tests/cli-flags.test.mjs. This mirrors zed-cli, whose own
 * `.cli-flags.toml` header notes that clap does the real parsing while that
 * file is the portable description, with a test preventing drift.
 *
 * Why the TOML is not simply parsed at runtime: this package ships zero
 * runtime dependencies and must not read files out of its own install
 * directory to function. Declaring the spec in TypeScript keeps `--help` and
 * dispatch dependency-free and type-checked; the drift test keeps the portable
 * file honest.
 */

export type FlagType = 'string' | 'bool' | 'integer' | 'float' | 'json' | 'array' | 'map';

export interface FlagSpec {
  /** snake_case key, matching the `[flags.<key>]` table name. */
  key: string;
  /** Environment variable this flag writes. */
  env: string;
  /** Long forms, kebab-case, without leading dashes. */
  aliases: string[];
  short?: string;
  type: FlagType;
  /**
   * Applied only when the flag is absent from argv AND the env var is unset.
   *
   * Deliberately never set on a flag whose env var is consumed by
   * envToLoggerOptions(): upstream flags-2-env lets a declared default outrank
   * a real environment variable, which here would fabricate configuration the
   * user never wrote and clobber their environment. The drift test enforces
   * that rule mechanically.
   */
  default?: string;
  help: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  flags: FlagSpec[];
  /** Positional argument names, for help output only. */
  positionals?: string[];
}

/** Env vars read by envToLoggerOptions() in src/config.ts. */
export const LIBRARY_CONTRACT_FLAGS: FlagSpec[] = [
  {
    key: 'app_name',
    env: 'NEXT_LOGGER_APP_NAME',
    aliases: ['app-name'],
    type: 'string',
    help: 'Application name stamped on every record.',
  },
  {
    key: 'logger_name',
    env: 'NEXT_LOGGER_NAME',
    aliases: ['logger-name'],
    type: 'string',
    help: 'Logger instance name.',
  },
  {
    key: 'max_level',
    env: 'NEXT_LOGGER_MAX_LEVEL',
    aliases: ['max-level'],
    short: 'L',
    type: 'string',
    help: 'Lowest level emitted (trace|debug|info|warn|error|fatal).',
  },
  {
    key: 'console',
    env: 'NEXT_LOGGER_CONSOLE',
    aliases: ['console'],
    type: 'bool',
    help: 'Write records to the console.',
  },
  {
    key: 'auto_send',
    env: 'NEXT_LOGGER_AUTO_SEND',
    aliases: ['auto-send'],
    type: 'bool',
    help: 'Send events without an explicit .send() call.',
  },
  {
    key: 'http_endpoint',
    env: 'NEXT_LOGGER_HTTP_ENDPOINT',
    aliases: ['http-endpoint'],
    type: 'string',
    help: 'HTTP transport endpoint.',
  },
  {
    key: 'http_fallback_endpoint',
    env: 'NEXT_LOGGER_HTTP_FALLBACK_ENDPOINT',
    aliases: ['http-fallback-endpoint'],
    type: 'string',
    help: 'HTTP transport fallback endpoint, tried when the primary fails.',
  },
  {
    key: 'error_tracking_url',
    env: 'NEXT_LOGGER_ERROR_TRACKING_URL',
    aliases: ['error-tracking-url'],
    type: 'string',
    help: 'Error-tracking endpoint for high-severity records.',
  },
  {
    key: 'error_tracking_fallback_url',
    env: 'NEXT_LOGGER_ERROR_TRACKING_FALLBACK_URL',
    aliases: ['error-tracking-fallback-url'],
    type: 'string',
    help: 'Error-tracking fallback endpoint.',
  },
  {
    key: 'error_tracking_min_level',
    env: 'NEXT_LOGGER_ERROR_TRACKING_MIN_LEVEL',
    aliases: ['error-tracking-min-level'],
    type: 'string',
    help: 'Lowest level forwarded to the error tracker.',
  },
  {
    key: 'supabase_url',
    env: 'NEXT_LOGGER_SUPABASE_URL',
    aliases: ['supabase-url'],
    type: 'string',
    help: 'Supabase project or Realtime WebSocket URL.',
  },
  {
    key: 'supabase_anon_key',
    env: 'NEXT_LOGGER_SUPABASE_ANON_KEY',
    aliases: ['supabase-anon-key'],
    type: 'string',
    help: 'Supabase publishable/anon key. Required alongside the URL.',
  },
  {
    key: 'supabase_channel',
    env: 'NEXT_LOGGER_SUPABASE_CHANNEL',
    aliases: ['supabase-channel'],
    type: 'string',
    help: 'Supabase Realtime channel name.',
  },
  {
    key: 'supabase_event',
    env: 'NEXT_LOGGER_SUPABASE_EVENT',
    aliases: ['supabase-event'],
    type: 'string',
    help: 'Supabase Realtime broadcast event name.',
  },
  {
    key: 'config_dir',
    env: 'NEXT_LOGGER_CONFIG_DIR',
    aliases: ['config-dir'],
    type: 'string',
    help: 'Directory searched for .next-logger.{ts,mts,mjs,js}.',
  },
];

/** CLI-only presentation flags. Safe to give defaults: config.ts never reads them. */
export const GLOBAL_FLAGS: FlagSpec[] = [
  ...LIBRARY_CONTRACT_FLAGS,
  {
    key: 'json',
    env: 'NEXT_LOGGER_CLI_JSON',
    aliases: ['json'],
    type: 'bool',
    default: 'false',
    help: 'Emit one machine-readable JSON object instead of human output.',
  },
  {
    key: 'color',
    env: 'NEXT_LOGGER_CLI_COLOR',
    aliases: ['color'],
    type: 'string',
    default: 'auto',
    help: 'Colorize output: auto|always|never. NO_COLOR is always honoured.',
  },
  {
    key: 'quiet',
    env: 'NEXT_LOGGER_CLI_QUIET',
    aliases: ['quiet'],
    short: 'q',
    type: 'bool',
    default: 'false',
    help: 'Suppress non-essential output.',
  },
];

export const COMMANDS: CommandSpec[] = [
  {
    name: 'smoke',
    summary: 'Verify an installed build: import it, assert the runtime, run the smoke test.',
    flags: [
      {
        key: 'package',
        env: 'NEXT_LOGGER_CLI_SMOKE_PACKAGE',
        aliases: ['package'],
        short: 'p',
        type: 'string',
        help: 'Directory of the installed package. Defaults to the CLI\'s own package root.',
      },
      {
        key: 'expect_runtime',
        env: 'NEXT_LOGGER_CLI_EXPECT_RUNTIME',
        aliases: ['expect-runtime'],
        type: 'string',
        help: 'Require the root export to resolve to this runtime (node|bun|deno|browser|edge|cloudflare).',
      },
      {
        key: 'depth',
        env: 'NEXT_LOGGER_CLI_SMOKE_DEPTH',
        aliases: ['depth'],
        type: 'string',
        default: 'basic',
        help: 'basic = import + runtime + r2gSmokeTest; full = adds context, redaction and limits checks.',
      },
    ],
  },
  {
    name: 'doctor',
    summary: 'Diagnose whether logging will behave correctly in this environment.',
    flags: [
      {
        key: 'strict',
        env: 'NEXT_LOGGER_CLI_STRICT',
        aliases: ['strict'],
        type: 'bool',
        default: 'false',
        help: 'Treat warnings as failures (exit 1).',
      },
    ],
  },
  {
    name: 'resolve',
    summary: "Walk the package's exports map and print what each subpath resolves to.",
    flags: [
      {
        key: 'condition',
        env: 'NEXT_LOGGER_CLI_CONDITIONS',
        aliases: ['condition'],
        short: 'c',
        type: 'array',
        help: 'Export condition to apply; repeatable. Implies --runtime is ignored.',
      },
      {
        key: 'runtime',
        env: 'NEXT_LOGGER_CLI_RUNTIME',
        aliases: ['runtime'],
        short: 'r',
        type: 'string',
        help: 'Shorthand condition set: node|bun|deno|browser|workerd|edge-light.',
      },
      {
        key: 'subpath',
        env: 'NEXT_LOGGER_CLI_SUBPATH',
        aliases: ['subpath'],
        short: 's',
        type: 'string',
        help: 'Limit output to one subpath, e.g. "." or "./context".',
      },
    ],
  },
  {
    name: 'pretty',
    summary: 'Render next-loggers/v1 NDJSON from stdin; non-JSON lines pass through.',
    flags: [
      {
        key: 'min_level',
        env: 'NEXT_LOGGER_CLI_MIN_LEVEL',
        aliases: ['min-level'],
        short: 'm',
        type: 'string',
        help: 'Drop records below this level.',
      },
      {
        key: 'grep',
        env: 'NEXT_LOGGER_CLI_GREP',
        aliases: ['grep'],
        short: 'g',
        type: 'string',
        help: 'Keep only records whose message matches this substring.',
      },
      {
        key: 'show_stack',
        env: 'NEXT_LOGGER_CLI_SHOW_STACK',
        aliases: ['show-stack'],
        type: 'bool',
        default: 'false',
        help: 'Print captured stack traces and error stacks.',
      },
      {
        key: 'output',
        env: 'NEXT_LOGGER_CLI_OUTPUT',
        aliases: ['output'],
        short: 'o',
        type: 'string',
        default: 'text',
        help: 'text = human output; json = re-emit filtered NDJSON so it composes.',
      },
    ],
  },
  {
    name: 'packages',
    summary: 'List independently publishable Zed/native packages and verify release metadata.',
    flags: [
      {
        key: 'target',
        env: 'NEXT_LOGGER_CLI_PACKAGE_TARGETS',
        aliases: ['target'],
        short: 't',
        type: 'array',
        help: 'Release target filter; repeatable. See the detailed CLI documentation.',
      },
      {
        key: 'registry',
        env: 'NEXT_LOGGER_CLI_PACKAGE_REGISTRIES',
        aliases: ['registry'],
        short: 'R',
        type: 'array',
        help: 'Registry filter; repeatable. See the detailed CLI documentation.',
      },
      {
        key: 'release_version',
        env: 'NEXT_LOGGER_CLI_RELEASE_VERSION',
        aliases: ['release-version'],
        type: 'string',
        help: 'Semantic version used to render immutable release tags; defaults to package.json.',
      },
      {
        key: 'check',
        env: 'NEXT_LOGGER_CLI_PACKAGES_CHECK',
        aliases: ['check'],
        type: 'bool',
        default: 'false',
        help: 'Verify the compiled release catalog against package.json and .zpkg.toml.',
      },
    ],
  },
  {
    name: 'flags',
    summary: 'Print the command/flag/env documentation, or check it against .cli-flags.toml.',
    flags: [
      {
        key: 'check',
        env: 'NEXT_LOGGER_CLI_FLAGS_CHECK',
        aliases: ['check'],
        type: 'bool',
        default: 'false',
        help: 'Exit 1 if .cli-flags.toml command, flag, env, or help metadata has drifted.',
      },
    ],
  },
];

export const BIN_NAME = 'next-loggers';

/** Env var carrying the resolved command path, per the flags-2-env convention. */
export const COMMAND_ENV = 'NEXT_LOGGER_CLI_COMMAND';

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** Every flag visible in a command's scope: its own, then the globals. */
export function flagsInScope(command: CommandSpec | undefined): FlagSpec[] {
  return command ? [...command.flags, ...GLOBAL_FLAGS] : [...GLOBAL_FLAGS];
}
