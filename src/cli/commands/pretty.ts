import { createInterface } from 'node:readline';

import type { CommandContext, CommandResult } from '../context.js';

/**
 * Renders `next-loggers/v1` NDJSON from stdin.
 *
 * Colour and layout live in a filter process rather than in the library, so
 * they never sit on the production hot path. Lines that are not our records
 * pass through untouched, so this is safe to append to any pipeline.
 */

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

const COLORS: Record<string, string> = {
  TRACE: '[90m',
  DEBUG: '[36m',
  INFO: '[32m',
  WARN: '[33m',
  ERROR: '[31m',
  FATAL: '[1;31m',
};
const DIM = '[2m';
const RESET = '[0m';

interface LogRecordLike {
  schema?: string;
  timestamp?: string;
  level?: string;
  appName?: string;
  message?: string;
  runtime?: string;
  traceId?: string;
  fields?: Record<string, unknown>;
  stackTrace?: string[];
  errors?: unknown[];
}

export async function runPretty(ctx: CommandContext): Promise<CommandResult> {
  const minLevel = ctx.flag('min_level')?.toUpperCase();
  const minIndex = minLevel ? LEVELS.indexOf(minLevel) : -1;
  if (minLevel && minIndex < 0) {
    ctx.printErr(`next-loggers pretty: unknown level "${minLevel}"`);
    return { exitCode: 2 };
  }
  const grep = ctx.flag('grep');
  const showStack = ctx.bool('show_stack');
  const asJson = (ctx.flag('output') ?? 'text') === 'json';

  const paint = (text: string, color: string): string =>
    ctx.color ? `${color}${text}${RESET}` : text;

  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let rendered = 0;

  for await (const line of reader) {
    if (line.trim() === '') {
      continue;
    }

    let record: LogRecordLike | undefined;
    if (line.startsWith('{')) {
      try {
        const parsed = JSON.parse(line) as LogRecordLike;
        if (parsed.schema === 'next-loggers/v1') {
          record = parsed;
        }
      } catch {
        // Not JSON after all — fall through to passthrough.
      }
    }

    if (!record) {
      // Anything that is not one of our records is someone else's output.
      ctx.print(line);
      continue;
    }

    const level = (record.level ?? 'INFO').toUpperCase();
    if (minIndex >= 0 && LEVELS.indexOf(level) < minIndex) {
      continue;
    }
    if (grep && !(record.message ?? '').includes(grep)) {
      continue;
    }

    rendered += 1;

    if (asJson) {
      ctx.print(JSON.stringify(record));
      continue;
    }

    const time = (record.timestamp ?? '').replace('T', ' ').replace('Z', '');
    const head = [
      paint(time, DIM),
      paint(level.padEnd(5), COLORS[level] ?? ''),
      record.appName ? paint(`[${record.appName}]`, DIM) : '',
      record.message ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    ctx.print(head);

    const fields = record.fields ?? {};
    const fieldKeys = Object.keys(fields);
    if (fieldKeys.length > 0) {
      const body = fieldKeys.map((key) => `${key}=${format(fields[key])}`).join(' ');
      ctx.print(paint(`      ${body}`, DIM));
    }
    if (record.traceId) {
      ctx.print(paint(`      trace=${record.traceId}`, DIM));
    }
    if (showStack && record.stackTrace?.length) {
      for (const frame of record.stackTrace) {
        ctx.print(paint(`      ${frame.trim()}`, DIM));
      }
    }
    if (showStack && record.errors?.length) {
      for (const error of record.errors) {
        const stack = (error as { stack?: string }).stack;
        if (stack) {
          ctx.print(paint(`      ${stack.split('\n').join('\n      ')}`, DIM));
        }
      }
    }
  }

  reader.close();
  return { exitCode: rendered === 0 ? 0 : 0 };
}

function format(value: unknown): string {
  if (typeof value === 'string') {
    return value.includes(' ') ? JSON.stringify(value) : value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
