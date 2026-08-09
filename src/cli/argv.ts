/**
 * flags-2-env argv parser: (spec, argv) -> a string->string environment map.
 *
 * Values are always strings, because the whole point of the format is that a
 * flag and its environment variable are interchangeable. Types validate; they
 * do not convert. Typed access is the caller's job (see coerce()).
 */

import {
  COMMAND_ENV,
  flagsInScope,
  findCommand,
  type CommandSpec,
  type FlagSpec,
  type FlagType,
} from './spec.js';

export interface ParseResult {
  command: CommandSpec | undefined;
  env: Record<string, string>;
  positionals: string[];
  errors: string[];
  helpRequested: boolean;
  versionRequested: boolean;
}

const TRUE_WORDS = new Set(['1', 'true', 't', 'yes', 'y', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

function matchLong(flags: FlagSpec[], name: string): FlagSpec | undefined {
  return flags.find((flag) => flag.aliases.includes(name));
}

function matchShort(flags: FlagSpec[], letter: string): FlagSpec | undefined {
  return flags.find((flag) => flag.short === letter);
}

/**
 * Whether a separated value may be consumed for this flag. An option-shaped
 * token is never swallowed unless the type can genuinely hold it — so
 * `--grep --json` leaves grep unset and lets --json parse, instead of
 * silently setting grep to "--json".
 */
function acceptsSeparatedValue(type: FlagType, token: string | undefined): boolean {
  if (token === undefined) {
    return false;
  }
  if (!token.startsWith('-') || token === '-') {
    return true;
  }
  if (type === 'integer' || type === 'float') {
    return /^-\d/.test(token);
  }
  return false;
}

function validate(flag: FlagSpec, raw: string): string | undefined {
  switch (flag.type) {
    case 'bool': {
      const lower = raw.toLowerCase();
      if (!TRUE_WORDS.has(lower) && !FALSE_WORDS.has(lower)) {
        return `--${flag.aliases[0]} expects a boolean, got "${raw}"`;
      }
      return undefined;
    }
    case 'integer':
      if (!/^[+-]?\d+$/.test(raw.trim())) {
        return `--${flag.aliases[0]} expects an integer, got "${raw}"`;
      }
      return undefined;
    case 'float':
      if (!Number.isFinite(Number(raw))) {
        return `--${flag.aliases[0]} expects a number, got "${raw}"`;
      }
      return undefined;
    case 'array': {
      // A repeatable flag takes either a JSON array or a bare scalar item, so
      // only a value that *looks* like JSON is held to the array shape —
      // otherwise `--condition node` would be rejected as invalid JSON.
      const trimmed = raw.trim();
      if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
        return undefined;
      }
      try {
        if (!Array.isArray(JSON.parse(trimmed))) {
          return `--${flag.aliases[0]} expects a JSON array`;
        }
      } catch {
        return `--${flag.aliases[0]} expects valid JSON, got "${raw}"`;
      }
      return undefined;
    }
    case 'json':
    case 'map':
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          flag.type === 'map' &&
          (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        ) {
          return `--${flag.aliases[0]} expects a JSON object`;
        }
      } catch {
        return `--${flag.aliases[0]} expects valid JSON, got "${raw}"`;
      }
      return undefined;
    default:
      return undefined;
  }
}

function normalizeBool(raw: string): string {
  return TRUE_WORDS.has(raw.toLowerCase()) ? 'true' : 'false';
}

export function parseArgv(argv: readonly string[]): ParseResult {
  const result: ParseResult = {
    command: undefined,
    env: {},
    positionals: [],
    errors: [],
    helpRequested: false,
    versionRequested: false,
  };

  // Repeatable flags accumulate rather than overwrite. flags-2-env has no
  // repeatable concept, so this is a documented superset: the env var still
  // holds a single JSON array, which is exactly what `array` declares.
  const accumulated = new Map<string, string[]>();

  const setValue = (flag: FlagSpec, raw: string): void => {
    const problem = validate(flag, raw);
    if (problem) {
      result.errors.push(problem);
      return;
    }
    if (flag.type === 'bool') {
      result.env[flag.env] = normalizeBool(raw);
      return;
    }
    if (flag.type === 'array') {
      // Accept either a JSON array or a bare scalar, accumulating repeats.
      let items: string[];
      try {
        const parsed: unknown = JSON.parse(raw);
        items = Array.isArray(parsed) ? parsed.map(String) : [raw];
      } catch {
        items = [raw];
      }
      const existing = accumulated.get(flag.env) ?? [];
      existing.push(...items);
      accumulated.set(flag.env, existing);
      result.env[flag.env] = JSON.stringify(existing);
      return;
    }
    result.env[flag.env] = raw;
  };

  let index = 0;
  let commandLocked = false;
  let sawTerminator = false;

  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) {
      continue;
    }

    if (sawTerminator) {
      result.positionals.push(token);
      continue;
    }
    if (token === '--') {
      sawTerminator = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      result.helpRequested = true;
      continue;
    }
    if (token === '--version' || token === '-V') {
      result.versionRequested = true;
      continue;
    }

    const scope = flagsInScope(result.command);

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      const name = equals >= 0 ? body.slice(0, equals) : body;
      const inlineValue = equals >= 0 ? body.slice(equals + 1) : undefined;

      let flag = matchLong(scope, name);

      // `--no-x` negates, and only for booleans: --no-endpoint on a string
      // flag is meaningless, so it is reported rather than silently dropped.
      if (!flag && name.startsWith('no-')) {
        const negated = matchLong(scope, name.slice(3));
        if (negated?.type === 'bool') {
          result.env[negated.env] = 'false';
          continue;
        }
      }

      if (!flag) {
        result.errors.push(`unknown flag --${name}`);
        continue;
      }

      if (inlineValue !== undefined) {
        setValue(flag, inlineValue);
        continue;
      }
      if (flag.type === 'bool') {
        // A bare boolean is true; it never consumes the next token.
        result.env[flag.env] = 'true';
        continue;
      }
      const next = argv[index];
      if (!acceptsSeparatedValue(flag.type, next)) {
        result.errors.push(`--${name} expects a value`);
        continue;
      }
      index += 1;
      setValue(flag, next as string);
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1);
      const first = body[0] as string;
      const flag = matchShort(scope, first);
      if (!flag) {
        result.errors.push(`unknown flag -${first}`);
        continue;
      }
      const rest = body.slice(1);

      if (rest.startsWith('=')) {
        setValue(flag, rest.slice(1));
        continue;
      }

      if (rest.length > 0) {
        // Bundle (-qv) only when every letter is a bool in scope; otherwise
        // the tail is an inline value (-p8080).
        const everyLetterIsBool =
          flag.type === 'bool' &&
          [...rest].every((letter) => matchShort(scope, letter)?.type === 'bool');
        if (everyLetterIsBool) {
          result.env[flag.env] = 'true';
          for (const letter of rest) {
            const bundled = matchShort(scope, letter) as FlagSpec;
            result.env[bundled.env] = 'true';
          }
          continue;
        }
        setValue(flag, rest);
        continue;
      }

      if (flag.type === 'bool') {
        result.env[flag.env] = 'true';
        continue;
      }
      const next = argv[index];
      if (!acceptsSeparatedValue(flag.type, next)) {
        result.errors.push(`-${first} expects a value`);
        continue;
      }
      index += 1;
      setValue(flag, next as string);
      continue;
    }

    // A positional: the first one that names a command selects it.
    if (!commandLocked) {
      const command = findCommand(token);
      if (command) {
        result.command = command;
        commandLocked = true;
        continue;
      }
    }
    result.positionals.push(token);
  }

  if (result.command) {
    result.env[COMMAND_ENV] = result.command.name;
  }
  return result;
}

/**
 * Applies declared defaults for flags that appeared neither in argv nor in the
 * environment.
 *
 * Upstream flags-2-env folds defaults into the parsed map and then lets that
 * map win over process.env, so a declared default outranks a real environment
 * variable. That is inverted here on purpose: these flags write the very
 * variables src/config.ts reads, and a default that beats the environment
 * would fabricate configuration the user never set.
 */
export function applyDefaults(
  flags: readonly FlagSpec[],
  parsed: Record<string, string>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out = { ...parsed };
  for (const flag of flags) {
    if (flag.default === undefined) {
      continue;
    }
    if (out[flag.env] === undefined && env[flag.env] === undefined) {
      out[flag.env] = flag.default;
    }
  }
  return out;
}

/** Reads a flag's effective value: argv/defaults first, then the environment. */
export function readFlag(
  flag: FlagSpec,
  parsed: Record<string, string>,
  env: Record<string, string | undefined>,
): string | undefined {
  return parsed[flag.env] ?? env[flag.env];
}

export function readBool(
  flag: FlagSpec,
  parsed: Record<string, string>,
  env: Record<string, string | undefined>,
): boolean {
  const raw = readFlag(flag, parsed, env);
  return raw !== undefined && TRUE_WORDS.has(raw.toLowerCase());
}

export function readArray(
  flag: FlagSpec,
  parsed: Record<string, string>,
  env: Record<string, string | undefined>,
): string[] {
  const raw = readFlag(flag, parsed, env);
  if (!raw) {
    return [];
  }
  try {
    const parsedValue: unknown = JSON.parse(raw);
    return Array.isArray(parsedValue) ? parsedValue.map(String) : [raw];
  } catch {
    return [raw];
  }
}
