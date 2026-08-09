/**
 * Compares `.cli-flags.toml` against the compiled spec, in both directions.
 *
 * A one-way check is what lets a contract rot: it catches a flag the TOML
 * forgot but not one the TOML still claims after the code dropped it. Shared
 * by `next-loggers flags --check` and tests/cli-flags.test.mjs so CI and
 * consumers run identical logic. Help text is part of the contract too: the
 * canonical flags-2-env CLI renders it directly into docs and completions.
 */

import { asTable, parseToml, type TomlTable, type TomlValue } from './toml.js';
import { COMMANDS, GLOBAL_FLAGS, LIBRARY_CONTRACT_FLAGS, type FlagSpec } from './spec.js';

export interface DeclaredFlag {
  scope: string;
  key: string;
  env: string;
  aliases: string[];
  short?: string;
  type: string;
  default?: string;
  help: string;
}

export interface DeclaredCommand {
  name: string;
  help: string;
}

export interface DriftReport {
  ok: boolean;
  missing: string[];
  stale: string[];
  mismatched: string[];
  missingCommands: string[];
  staleCommands: string[];
  mismatchedCommands: string[];
  policyViolations: string[];
}

function readFlagTable(scope: string, key: string, table: TomlTable): DeclaredFlag {
  const allowed = new Set(['env', 'aliases', 'short', 'type', 'default', 'help']);
  for (const found of Object.keys(table)) {
    if (!allowed.has(found)) {
      throw new Error(`[${scope}.flags.${key}] has unknown key "${found}"`);
    }
  }
  const env = table.env;
  if (typeof env !== 'string') {
    throw new Error(`[${scope}.flags.${key}] is missing a string "env"`);
  }
  const aliases = table.aliases;
  if (!Array.isArray(aliases)) {
    throw new Error(`[${scope}.flags.${key}] is missing an "aliases" array`);
  }
  const type = table.type;
  if (typeof type !== 'string') {
    throw new Error(`[${scope}.flags.${key}] is missing a string "type"`);
  }
  const help = table.help;
  if (typeof help !== 'string') {
    throw new Error(`[${scope}.flags.${key}] is missing a string "help"`);
  }
  const flag: DeclaredFlag = { scope, key, env, aliases, type, help };
  if (typeof table.short === 'string') {
    flag.short = table.short;
  }
  if (typeof table.default === 'string') {
    flag.default = table.default;
  }
  return flag;
}

/** Collects every `flags.<key>` table at any depth, including command scopes. */
export function collectDeclared(document: TomlTable): {
  flags: DeclaredFlag[];
  commands: DeclaredCommand[];
} {
  const flags: DeclaredFlag[] = [];
  const commands: DeclaredCommand[] = [];

  const walkFlags = (scope: string, node: TomlValue | undefined): void => {
    if (node === undefined) {
      return;
    }
    const table = asTable(node, `${scope}.flags`);
    for (const [key, value] of Object.entries(table)) {
      flags.push(readFlagTable(scope, key, asTable(value, `${scope}.flags.${key}`)));
    }
  };

  walkFlags('global', document.flags);

  const commandsTable = document.commands;
  if (commandsTable !== undefined) {
    const table = asTable(commandsTable, 'commands');
    for (const [name, value] of Object.entries(table)) {
      const commandTable = asTable(value, `commands.${name}`);
      const allowed = new Set(['help', 'flags']);
      for (const found of Object.keys(commandTable)) {
        if (!allowed.has(found)) {
          throw new Error(`[commands.${name}] has unknown key "${found}"`);
        }
      }
      const help = commandTable.help;
      if (typeof help !== 'string') {
        throw new Error(`[commands.${name}] is missing a string "help"`);
      }
      commands.push({ name, help });
      walkFlags(name, commandTable.flags);
      if (commandTable.commands !== undefined) {
        throw new Error(`nested subcommands under "${name}" are not supported by this CLI`);
      }
    }
  }

  return { flags, commands };
}

function specFlags(): DeclaredFlag[] {
  const out: DeclaredFlag[] = GLOBAL_FLAGS.map((flag) => toDeclared('global', flag));
  for (const command of COMMANDS) {
    for (const flag of command.flags) {
      out.push(toDeclared(command.name, flag));
    }
  }
  return out;
}

function toDeclared(scope: string, flag: FlagSpec): DeclaredFlag {
  const declared: DeclaredFlag = {
    scope,
    key: flag.key,
    env: flag.env,
    aliases: [...flag.aliases],
    type: flag.type,
    help: flag.help,
  };
  if (flag.short !== undefined) {
    declared.short = flag.short;
  }
  if (flag.default !== undefined) {
    declared.default = flag.default;
  }
  return declared;
}

function identity(flag: DeclaredFlag): string {
  return `${flag.scope}.${flag.key}`;
}

export function compare(document: TomlTable): DriftReport {
  const declared = collectDeclared(document);
  const compiled = specFlags();

  const declaredByIdentity = new Map(declared.flags.map((flag) => [identity(flag), flag]));
  const compiledByIdentity = new Map(compiled.map((flag) => [identity(flag), flag]));

  const missing: string[] = [];
  const stale: string[] = [];
  const mismatched: string[] = [];

  for (const [key, flag] of compiledByIdentity) {
    const other = declaredByIdentity.get(key);
    if (!other) {
      missing.push(`${key} (in the compiled spec, absent from .cli-flags.toml)`);
      continue;
    }
    if (other.env !== flag.env) {
      mismatched.push(`${key}: env "${other.env}" vs "${flag.env}"`);
    }
    if (other.type !== flag.type) {
      mismatched.push(`${key}: type "${other.type}" vs "${flag.type}"`);
    }
    if (other.aliases.join(',') !== flag.aliases.join(',')) {
      mismatched.push(`${key}: aliases [${other.aliases}] vs [${flag.aliases}]`);
    }
    if ((other.short ?? '') !== (flag.short ?? '')) {
      mismatched.push(`${key}: short "${other.short ?? ''}" vs "${flag.short ?? ''}"`);
    }
    if ((other.default ?? '') !== (flag.default ?? '')) {
      mismatched.push(`${key}: default "${other.default ?? ''}" vs "${flag.default ?? ''}"`);
    }
    if (other.help !== flag.help) {
      mismatched.push(`${key}: help ${JSON.stringify(other.help)} vs ${JSON.stringify(flag.help)}`);
    }
  }
  for (const key of declaredByIdentity.keys()) {
    if (!compiledByIdentity.has(key)) {
      stale.push(`${key} (declared in .cli-flags.toml, absent from the compiled spec)`);
    }
  }

  const compiledCommands = new Map(COMMANDS.map((command) => [command.name, command]));
  const declaredCommands = new Map(declared.commands.map((command) => [command.name, command]));
  const missingCommands = [...compiledCommands.keys()]
    .filter((name) => !declaredCommands.has(name))
    .sort();
  const staleCommands = [...declaredCommands.keys()]
    .filter((name) => !compiledCommands.has(name))
    .sort();
  const mismatchedCommands: string[] = [];
  for (const [name, command] of compiledCommands) {
    const other = declaredCommands.get(name);
    if (other && other.help !== command.summary) {
      mismatchedCommands.push(
        `${name}: help ${JSON.stringify(other.help)} vs ${JSON.stringify(command.summary)}`,
      );
    }
  }

  // Policy: no flag whose env is consumed by envToLoggerOptions() may declare a
  // default, or the default would fabricate configuration the user never set.
  const contractEnvs = new Set(LIBRARY_CONTRACT_FLAGS.map((flag) => flag.env));
  const policyViolations: string[] = [];
  for (const flag of [...compiled, ...declared.flags]) {
    if (contractEnvs.has(flag.env) && flag.default !== undefined) {
      policyViolations.push(
        `${identity(flag)} declares default="${flag.default}" but ${flag.env} is read by envToLoggerOptions()`,
      );
    }
  }

  // Env vars must be unique across the whole document.
  const seenEnv = new Map<string, string>();
  for (const flag of declared.flags) {
    const previous = seenEnv.get(flag.env);
    if (previous) {
      mismatched.push(`${flag.env} is declared twice: ${previous} and ${identity(flag)}`);
    }
    seenEnv.set(flag.env, identity(flag));
  }

  return {
    ok:
      missing.length === 0 &&
      stale.length === 0 &&
      mismatched.length === 0 &&
      missingCommands.length === 0 &&
      staleCommands.length === 0 &&
      mismatchedCommands.length === 0 &&
      policyViolations.length === 0,
    missing,
    stale,
    mismatched,
    missingCommands,
    staleCommands,
    mismatchedCommands,
    policyViolations,
  };
}

export function compareSource(tomlSource: string): DriftReport {
  return compare(parseToml(tomlSource));
}
