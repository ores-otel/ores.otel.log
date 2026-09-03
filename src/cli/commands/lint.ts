/**
 * `next-loggers lint` — dependency-free, polyglot missing-send diagnostics.
 *
 * A chainable next-loggers event reaches transports only after its terminal
 * send call. This scanner reports bare expression statements that construct
 * an event and then drop it. Assigned, returned, awaited, or argument-position
 * events remain out of scope because another call site may complete them.
 *
 * The scanner intentionally remains conservative. It first requires a
 * next-loggers import/use marker unless `--all` or `--logger-name` is supplied,
 * blanks comments and string bodies while preserving source offsets, groups
 * multi-line chains into one statement, and emits the stable diagnostic NL100.
 */

import type { CommandContext, CommandResult } from '../context.js';

export type Language = 'javascript' | 'typescript' | 'go' | 'rust' | 'python' | 'gleam';

export interface LintFinding {
  file: string;
  line: number;
  column: number;
  language: Language;
  code: 'NL100';
  message: string;
}

export interface LintSourceOptions {
  all?: boolean;
  loggerNames?: readonly string[];
}

const LEVEL_METHODS = ['trace', 'debug', 'info', 'log', 'warn', 'error', 'fatal'] as const;
const DEFAULT_LOGGER_NAMES = ['log', 'logger', 'ddlog'] as const;
const MESSAGE = 'next-loggers event is never sent; call send() so it reaches transports';

const EXTENSIONS: ReadonlyMap<string, Language> = new Map([
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.jsx', 'javascript'],
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.py', 'python'],
  ['.gleam', 'gleam'],
]);

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  'vendor',
  '.vendor',
  '.git',
  '.zed',
  '_build',
  'deps',
]);

function blankRange(characters: string[], start: number, end: number): void {
  for (let index = start; index < end && index < characters.length; index += 1) {
    if (characters[index] !== '\n' && characters[index] !== '\r') {
      characters[index] = ' ';
    }
  }
}

function quotedEnd(source: string, start: number, delimiter: string): number {
  let cursor = start + delimiter.length;
  while (cursor < source.length) {
    if (delimiter.length === 1 && source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source.startsWith(delimiter, cursor)) {
      return cursor + delimiter.length;
    }
    cursor += 1;
  }
  return source.length;
}

function rustRawString(source: string, start: number): { delimiter: string; end: number } | undefined {
  const match = /^r(#{0,16})"/.exec(source.slice(start));
  if (!match) {
    return undefined;
  }
  const hashes = match[1] ?? '';
  const openingLength = 2 + hashes.length;
  const closing = `"${hashes}`;
  const closeAt = source.indexOf(closing, start + openingLength);
  return {
    delimiter: source.slice(start, start + openingLength),
    end: closeAt === -1 ? source.length : closeAt + closing.length,
  };
}

/**
 * Blanks comments and optionally string bodies while preserving code-unit
 * offsets, line breaks, and therefore diagnostics. Keeping strings is useful
 * while discovering import aliases; blanking them is required for call scans.
 */
function blankLexical(source: string, language: Language, strings: boolean): string {
  const characters = source.split('');
  const lineComment = language === 'python' ? '#' : '//';
  let index = 0;

  while (index < source.length) {
    if (source.startsWith(lineComment, index)) {
      const lineEnd = source.indexOf('\n', index);
      const end = lineEnd === -1 ? source.length : lineEnd;
      blankRange(characters, index, end);
      index = end;
      continue;
    }

    if (language !== 'python' && source.startsWith('/*', index)) {
      const closeAt = source.indexOf('*/', index + 2);
      const end = closeAt === -1 ? source.length : closeAt + 2;
      blankRange(characters, index, end);
      index = end;
      continue;
    }

    if (language === 'rust') {
      const raw = rustRawString(source, index);
      if (raw) {
        if (strings) {
          blankRange(characters, index, raw.end);
        }
        index = raw.end;
        continue;
      }
    }

    const triple =
      language === 'python' && (source.startsWith("'''", index) || source.startsWith('"""', index))
        ? source.slice(index, index + 3)
        : undefined;
    if (triple) {
      const end = quotedEnd(source, index, triple);
      if (strings) {
        blankRange(characters, index, end);
      }
      index = end;
      continue;
    }

    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      const end = quotedEnd(source, index, character);
      if (strings) {
        blankRange(characters, index, end);
      }
      index = end;
      continue;
    }

    index += 1;
  }

  return characters.join('');
}

/** Replaces comments and string content with spaces, preserving offsets. */
export function blankNonCode(source: string, language: Language): string {
  return blankLexical(source, language, true);
}

function referencesNextLoggers(commentFreeSource: string, language: Language): boolean {
  switch (language) {
    case 'javascript':
    case 'typescript':
      return /(?:from\s*|import\s*\(|require\s*\()\s*['"][^'"]*(?:@oresoftware\/next-loggers|next-loggers)[^'"]*['"]/.test(
        commentFreeSource,
      );
    case 'go':
      return /['"][^'"]*(?:next-loggers|ores\.otel\.log)\/sdk\/go['"]/.test(commentFreeSource);
    case 'rust':
      return /\b(?:use|extern\s+crate)\s+[^;\n]*(?:next_loggers|oresoftware_next_loggers)/.test(
        commentFreeSource,
      );
    case 'python':
      return /\b(?:from|import)\s+(?:next_loggers|oresoftware_next_loggers)\b/.test(
        commentFreeSource,
      );
    case 'gleam':
      return /\bimport\s+[^\s]*(?:next_loggers|oresoftware_next_loggers)/.test(commentFreeSource);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function discoverLoggerNames(
  code: string,
  commentFreeSource: string,
  language: Language,
  extra: readonly string[],
): Set<string> {
  const names = new Set<string>([...DEFAULT_LOGGER_NAMES, ...extra]);
  const factories = new Set<string>([
    'createLogger',
    'createBrowserLogger',
    'createEdgeLogger',
    'createCloudflareWorkerLogger',
    'createNodeLogger',
    'createBunLogger',
    'createDenoLogger',
  ]);

  if (language === 'javascript' || language === 'typescript') {
    for (const match of commentFreeSource.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*next-loggers[^'"]*['"]/g,
    )) {
      for (const entry of (match[1] ?? '').split(',')) {
        const parts = entry.trim().split(/\s+as\s+/);
        const imported = parts[0]?.trim();
        const local = (parts[1] ?? parts[0])?.trim();
        if (imported && local && factories.has(imported)) {
          factories.add(local);
        }
      }
    }
  }

  const factoryAlternation = [...factories].map(escapeRegExp).join('|');
  const patterns: RegExp[] = [
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w.]*(?:create\w*Logger|NewLogger|Logger::new|Logger)\s*\(/g,
    new RegExp(
      String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:${factoryAlternation})\s*\(`,
      'g',
    ),
    /([A-Za-z_][\w]*)\s*:?=\s*[\w.]*(?:NewLogger|Logger::new|Logger)\s*\(/g,
    /let\s+([A-Za-z_][\w]*)\s*=\s*[\w.]*(?:new|logging\.new)\s*\(/g,
  ];

  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1];
      if (name) {
        names.add(name);
      }
    }
  }

  if (language === 'gleam') {
    for (const match of commentFreeSource.matchAll(
      /import\s+[\w/]*next_loggers\S*\s+as\s+([a-z_][\w]*)/g,
    )) {
      const name = match[1];
      if (name) {
        names.add(name);
      }
    }
    names.add('logging');
    names.add('oresoftware_next_loggers');
  }

  return names;
}

function levelPattern(names: Iterable<string>, language: Language): RegExp {
  const loggerAlternation = [...names].map(escapeRegExp).join('|');
  const levels =
    language === 'go'
      ? LEVEL_METHODS.map((level) => level[0]!.toUpperCase() + level.slice(1))
      : LEVEL_METHODS;
  return new RegExp(
    String.raw`\b(?:${loggerAlternation})\s*(?:\.|\?\.)\s*(?:${levels.join('|')})\s*\(`,
    'g',
  );
}

function sendPattern(language: Language): RegExp {
  switch (language) {
    case 'go':
      return /\.(?:Send|SendWithStore)\s*\(/;
    case 'gleam':
      return /(?:\.|\|>\s*[\w.]*)send(?:_with_store)?\b/;
    case 'javascript':
    case 'typescript':
    case 'rust':
    case 'python':
      return /\.(?:send|send_with_store|sendWithStore)\s*\(/;
  }
}

function previousLine(code: string, lineStart: number): string {
  let cursor = lineStart;
  while (cursor > 0) {
    const end = cursor - 1;
    const begin = code.lastIndexOf('\n', end - 1) + 1;
    const line = code.slice(begin, end);
    if (line.trim()) {
      return line.trim();
    }
    cursor = begin;
  }
  return '';
}

function statementEnd(code: string, start: number): number {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const character = code[index];
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) {
      continue;
    }
    if (character === ';') {
      return index + 1;
    }
    if (character === '\n') {
      const currentLineStart = code.lastIndexOf('\n', index - 1) + 1;
      const currentLine = code.slice(currentLineStart, index).trimEnd();
      const nextBreak = code.indexOf('\n', index + 1);
      const nextLine = code.slice(index + 1, nextBreak === -1 ? undefined : nextBreak);
      const explicitlyContinued = currentLine.endsWith('\\');
      const nextContinues = /^\s*(?:\.|\?\.|\|>|\)|\}|\])/.test(nextLine);
      if (!explicitlyContinued && !nextContinues) {
        return index;
      }
    }
  }
  return code.length;
}

export function checkSource(
  source: string,
  language: Language,
  options: { file?: string; loggerNames?: readonly string[]; requireImport?: boolean } = {},
): LintFinding[] {
  const file = options.file ?? '<source>';
  const extra = options.loggerNames ?? [];
  const commentFreeSource = blankLexical(source, language, false);

  if ((options.requireImport ?? true) && extra.length === 0) {
    if (!referencesNextLoggers(commentFreeSource, language)) {
      return [];
    }
  }

  const code = blankNonCode(source, language);
  const names = discoverLoggerNames(code, commentFreeSource, language, extra);
  const level = levelPattern(names, language);
  const send = sendPattern(language);
  const findings: LintFinding[] = [];

  for (const match of code.matchAll(level)) {
    const start = match.index ?? 0;
    const lineStart = code.lastIndexOf('\n', start - 1) + 1;

    // A non-whitespace prefix means this event is assigned, returned, awaited,
    // nested in another expression, or otherwise not a dropped bare statement.
    if (code.slice(lineStart, start).trim() !== '') {
      continue;
    }

    // Reject a match whose logger began on a continuation from the prior line.
    if (/[,([=+&|:?]$|\|>$|->$|=>$|\.$/.test(previousLine(code, lineStart))) {
      continue;
    }

    if (send.test(code.slice(start, statementEnd(code, start)))) {
      continue;
    }

    const before = code.slice(0, start);
    findings.push({
      file,
      line: before.split('\n').length,
      column: start - (before.lastIndexOf('\n') + 1) + 1,
      language,
      code: 'NL100',
      message: MESSAGE,
    });
  }

  return findings;
}

/** JS/TS-focused wrapper retained for editor and unit-test integrations. */
export function lintSource(
  source: string,
  file = '<source>',
  options: LintSourceOptions = {},
): LintFinding[] {
  const fromPath = languageForPath(file);
  const language =
    fromPath === 'javascript' || fromPath === 'typescript' ? fromPath : 'typescript';
  return checkSource(source, language, {
    file,
    ...(options.loggerNames === undefined ? {} : { loggerNames: options.loggerNames }),
    requireImport: !options.all && (options.loggerNames?.length ?? 0) === 0,
  });
}

export function languageForPath(path: string): Language | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : EXTENSIONS.get(path.slice(dot).toLowerCase());
}

async function collectFiles(targets: readonly string[]): Promise<string[]> {
  const { lstat, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const files = new Set<string>();

  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return;
    }
    if (!info.isDirectory()) {
      if (info.isFile() && languageForPath(path)) {
        files.add(path);
      }
      return;
    }

    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        await walk(join(path, entry.name));
        continue;
      }
      if (entry.isFile()) {
        const child = join(path, entry.name);
        if (languageForPath(child)) {
          files.add(child);
        }
      }
    }
  };

  for (const target of targets) {
    await walk(target);
  }

  return [...files].sort();
}

export async function runLint(ctx: CommandContext): Promise<CommandResult> {
  const { readFile } = await import('node:fs/promises');
  const targets = ctx.positionals.length > 0 ? ctx.positionals : ['.'];
  const extra = ctx.list('logger_name');
  const requireImport = !ctx.bool('all') && extra.length === 0;

  let files: string[];
  try {
    files = await collectFiles(targets);
  } catch (error) {
    ctx.printErr(`lint: ${String(error)}`);
    return { exitCode: 2 };
  }

  const findings: LintFinding[] = [];
  try {
    for (const file of files) {
      const language = languageForPath(file);
      if (!language) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      findings.push(...checkSource(source, language, { file, loggerNames: extra, requireImport }));
    }
  } catch (error) {
    ctx.printErr(`lint: ${String(error)}`);
    return { exitCode: 2 };
  }

  if (ctx.json) {
    ctx.print(
      JSON.stringify({
        schema: 'next-loggers/lint/v1',
        passed: findings.length === 0,
        filesChecked: files.length,
        findings,
      }),
    );
  } else {
    for (const finding of findings) {
      ctx.print(
        `${finding.file}:${finding.line}:${finding.column}: ${finding.code} ${finding.message}`,
      );
    }
    ctx.print(
      findings.length === 0
        ? `lint: checked ${files.length} file(s); every next-loggers event is sent`
        : `lint: ${findings.length} unsent event(s) in ${files.length} checked file(s)`,
    );
  }

  return { exitCode: findings.length > 0 ? 1 : 0 };
}
