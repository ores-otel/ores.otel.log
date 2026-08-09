#!/usr/bin/env node
/**
 * next-loggers CLI entry point.
 *
 * Flags follow the flags-2-env convention: every flag has an environment
 * variable, and parsed flags are written into process.env before dispatch —
 * so a command that later calls loadNextLoggerConfig() picks them up with no
 * plumbing. That is the whole reason the env names match src/config.ts.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyDefaults, parseArgv } from './argv.js';
import { CommandContext, type CommandResult } from './context.js';
import { renderCommandHelp, renderRootHelp } from './help.js';
import { BIN_NAME, flagsInScope } from './spec.js';

/** dist/cli/main.js → the package root two levels up. */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

async function readVersion(root: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const root = packageRoot();

  if (parsed.versionRequested) {
    process.stdout.write(`${BIN_NAME} ${await readVersion(root)}\n`);
    return 0;
  }
  if (parsed.helpRequested) {
    process.stdout.write(
      parsed.command ? renderCommandHelp(parsed.command) : renderRootHelp(),
    );
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      process.stderr.write(`${BIN_NAME}: ${error}\n`);
    }
    process.stderr.write(`Run \`${BIN_NAME} --help\`.\n`);
    return 2;
  }
  if (!parsed.command) {
    if (parsed.positionals.length > 0) {
      process.stderr.write(`${BIN_NAME}: unknown command "${parsed.positionals[0]}"\n`);
      return 2;
    }
    process.stdout.write(renderRootHelp());
    return 0;
  }

  const withDefaults = applyDefaults(flagsInScope(parsed.command), parsed.env, process.env);

  // Written through to the environment so downstream config loading sees them.
  for (const [key, value] of Object.entries(withDefaults)) {
    process.env[key] = value;
  }

  const ctx = new CommandContext({
    command: parsed.command,
    parsed: withDefaults,
    positionals: parsed.positionals,
    env: process.env,
    packageRoot: root,
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    colorCapable: Boolean(process.stdout.isTTY),
  });

  // Dynamic import so `--help` never pays for every command's module graph.
  let result: CommandResult;
  switch (parsed.command.name) {
    case 'smoke':
      result = await (await import('./commands/smoke.js')).runSmoke(ctx);
      break;
    case 'doctor':
      result = await (await import('./commands/doctor.js')).runDoctor(ctx);
      break;
    case 'resolve':
      result = await (await import('./commands/resolve.js')).runResolve(ctx);
      break;
    case 'pretty':
      result = await (await import('./commands/pretty.js')).runPretty(ctx);
      break;
    case 'packages':
      result = await (await import('./commands/packages.js')).runPackages(ctx);
      break;
    case 'flags':
      result = await (await import('./commands/flags.js')).runFlags(ctx);
      break;
    default:
      process.stderr.write(`${BIN_NAME}: unhandled command "${parsed.command.name}"\n`);
      return 2;
  }
  return result.exitCode;
}

// Only self-execute as a program, so tests can import main() directly.
const invokedPath = process.argv[1];
const isEntryPoint =
  invokedPath !== undefined &&
  import.meta.url === new URL(`file://${invokedPath}`).href.replace(/\\/g, '/');

if (isEntryPoint || process.env.NEXT_LOGGER_CLI_FORCE_RUN === '1') {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${BIN_NAME}: ${String(error)}\n`);
      process.exitCode = 1;
    });
}
