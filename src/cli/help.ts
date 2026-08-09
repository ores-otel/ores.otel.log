import { BIN_NAME, COMMANDS, GLOBAL_FLAGS, type CommandSpec, type FlagSpec } from './spec.js';

const HELP_URL = 'https://github.com/ORESoftware/next-loggers.ts/blob/main/docs/CLI.md';

function optionColumn(flag: FlagSpec): string {
  const longs = flag.aliases.map((alias) => `--${alias}`).join(', ');
  return flag.short ? `-${flag.short}, ${longs}` : `    ${longs}`;
}

function renderFlagTable(flags: readonly FlagSpec[]): string[] {
  if (flags.length === 0) {
    return [];
  }
  const rows = flags.map((flag) => ({
    options: optionColumn(flag),
    env: flag.env,
    type: flag.type,
    fallback: flag.default ?? '',
    help: flag.help,
  }));
  const optionWidth = Math.max(...rows.map((row) => row.options.length));
  const envWidth = Math.max(...rows.map((row) => row.env.length));
  const typeWidth = Math.max(...rows.map((row) => row.type.length));
  const defaultWidth = Math.max(...rows.map((row) => row.fallback.length));

  return rows.map((row) => {
    const parts = [
      `  ${row.options.padEnd(optionWidth)}`,
      row.env.padEnd(envWidth),
      row.type.padEnd(typeWidth),
      row.fallback.padEnd(defaultWidth),
      row.help,
    ];
    return parts.join('  ').trimEnd();
  });
}

export function renderRootHelp(): string {
  const commandWidth = Math.max(...COMMANDS.map((command) => command.name.length));
  return [
    'next-loggers — runtime-aware ESM loggers',
    '',
    `Usage: ${BIN_NAME} <command> [options]`,
    '',
    'Commands:',
    ...COMMANDS.map(
      (command) => `  ${command.name.padEnd(commandWidth)}  ${command.summary}`,
    ),
    '',
    'Global options (every flag is also settable via its environment variable):',
    ...renderFlagTable(GLOBAL_FLAGS),
    '',
    `Run \`${BIN_NAME} <command> --help\` for command-specific options.`,
    HELP_URL,
    '',
  ].join('\n');
}

export function renderCommandHelp(command: CommandSpec): string {
  const lines = [
    `${BIN_NAME} ${command.name} — ${command.summary}`,
    '',
    `Usage: ${BIN_NAME} ${command.name} [options]`,
    '',
  ];
  if (command.flags.length > 0) {
    lines.push('Options:', ...renderFlagTable(command.flags), '');
  }
  lines.push('Global options:', ...renderFlagTable(GLOBAL_FLAGS), '', HELP_URL, '');
  return lines.join('\n');
}
