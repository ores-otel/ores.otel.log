/**
 * A strict, fail-closed reader for the TOML subset `.cli-flags.toml` uses.
 *
 * Deliberately NOT a general TOML parser. It supports exactly what the
 * flags-2-env format needs — tables, bare/quoted keys, basic strings,
 * integers, floats, booleans, and homogeneous (single- or multi-line) arrays
 * of strings or numbers, which `.ores-otel.toml` histogram boundaries need —
 * and throws on anything else.
 *
 * Failing closed is the entire value here. The upstream C parser silently
 * ignores unknown sections and unknown keys, so `alias =` instead of
 * `aliases =` would slip through unnoticed; a lenient reader would let the
 * drift test pass while the contract quietly rotted.
 */

export type TomlValue = string | number | boolean | string[] | number[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'TomlError';
    this.line = line;
  }
}

function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      // Count preceding backslashes to respect escaped quotes.
      let backslashes = 0;
      for (let back = index - 1; back >= 0 && line[back] === '\\'; back -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) {
        inString = !inString;
      }
    } else if (char === '#' && !inString) {
      return line.slice(0, index);
    }
  }
  return line;
}

// HOT-PATH (imperative by design): a cursor scan over one string literal; the
// accumulator never escapes this call.
function parseString(raw: string, lineNumber: number): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    throw new TomlError(`expected a double-quoted string, got ${raw}`, lineNumber);
  }
  if (raw.startsWith('"""')) {
    throw new TomlError('multi-line strings are not supported', lineNumber);
  }
  const body = raw.slice(1, -1);
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? '';
    const code = char.charCodeAt(0);
    if (char === '"') {
      throw new TomlError('unescaped quote inside string', lineNumber);
    }
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      throw new TomlError('control character in string', lineNumber);
    }
    if (char !== '\\') {
      out += char;
      continue;
    }
    index += 1;
    const escape = body[index];
    switch (escape) {
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case 'u':
      case 'U': {
        const digits = escape === 'u' ? 4 : 8;
        const hex = body.slice(index + 1, index + 1 + digits);
        if (hex.length !== digits || !/^[0-9A-Fa-f]+$/u.test(hex)) {
          throw new TomlError('invalid unicode escape', lineNumber);
        }
        const scalar = Number.parseInt(hex, 16);
        if (scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
          throw new TomlError('invalid unicode scalar value', lineNumber);
        }
        out += String.fromCodePoint(scalar);
        index += digits;
        break;
      }
      default:
        throw new TomlError(`unsupported escape \\${escape ?? ''}`, lineNumber);
    }
  }
  return out;
}

/** Net bracket depth of a line, ignoring brackets inside strings. */
function bracketDepth(line: string): number {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      let backslashes = 0;
      for (let back = index - 1; back >= 0 && line[back] === '\\'; back -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) {
        inString = !inString;
      }
    } else if (!inString && char === '[') {
      depth += 1;
    } else if (!inString && char === ']') {
      depth -= 1;
    }
  }
  return depth;
}

// TOML forbids leading zeros; a float needs a fraction or an exponent.
const INTEGER = /^[+-]?(0|[1-9]\d*)$/;
const FLOAT = /^[+-]?(0|[1-9]\d*)(\.\d+([eE][+-]?\d+)?|[eE][+-]?\d+)$/;

function parseArrayItem(item: string, lineNumber: number): string | number {
  if (item.startsWith('"')) {
    return parseString(item, lineNumber);
  }
  if (INTEGER.test(item)) {
    return Number.parseInt(item, 10);
  }
  if (FLOAT.test(item)) {
    return Number.parseFloat(item);
  }
  throw new TomlError(`arrays may contain only strings or numbers, got ${item}`, lineNumber);
}

function parseArray(raw: string, lineNumber: number): string[] | number[] {
  const values = splitArrayItems(raw).map((item) => parseArrayItem(item, lineNumber));
  if (values.every((value): value is string => typeof value === 'string')) {
    return values;
  }
  if (values.every((value): value is number => typeof value === 'number')) {
    return values;
  }
  throw new TomlError('arrays must not mix strings and numbers', lineNumber);
}

function splitArrayItems(raw: string): string[] {
  const body = raw.slice(1, -1).trim();
  if (body === '') {
    return [];
  }
  const items: string[] = [];
  let current = '';
  let inString = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"') {
      let backslashes = 0;
      for (let back = index - 1; back >= 0 && body[back] === '\\'; back -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) {
        inString = !inString;
      }
      current += char;
    } else if (char === ',' && !inString) {
      items.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') {
    items.push(current.trim());
  }
  return items;
}

function parseValue(raw: string, lineNumber: number): TomlValue {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new TomlError('missing value', lineNumber);
  }
  if (trimmed.startsWith('"')) {
    return parseString(trimmed, lineNumber);
  }
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) {
      throw new TomlError('unterminated array', lineNumber);
    }
    return parseArray(trimmed, lineNumber);
  }
  if (trimmed.startsWith('{')) {
    throw new TomlError('inline tables are not supported', lineNumber);
  }
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (INTEGER.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  if (FLOAT.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }
  throw new TomlError(`unsupported value ${trimmed}`, lineNumber);
}

/** Splits a table header into its dotted parts, honouring quoted segments. */
function splitPath(header: string, lineNumber: number): string[] {
  const parts: string[] = [];
  let current = '';
  let inString = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (char === '"') {
      inString = !inString;
      current += char;
    } else if (char === '.' && !inString) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts.map((part) => {
    if (part.startsWith('"')) {
      return parseString(part, lineNumber);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(part)) {
      throw new TomlError(`invalid key segment "${part}"`, lineNumber);
    }
    return part;
  });
}

export interface ParseTomlOptions {
  /**
   * Called with the full key path of every scalar written as a float literal
   * (`5000.0`, `1e3`). JavaScript numbers cannot tell `1` from `1.0`, so
   * callers that require TOML integers use this to reject float spellings.
   */
  readonly onFloat?: (path: readonly string[]) => void;
}

// HOT-PATH (imperative by design): a line cursor that builds one private table
// tree; nothing mutable escapes except the returned result.
export function parseToml(input: string, options: ParseTomlOptions = {}): TomlTable {
  const root: TomlTable = {};
  let current = root;
  let currentPath: readonly string[] = [];
  const definedTables = new Set<TomlTable>();
  const lines = input.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index] ?? '').trim();
    if (line === '') {
      continue;
    }

    if (line.startsWith('[[')) {
      throw new TomlError('arrays of tables are not supported', lineNumber);
    }

    if (line.startsWith('[')) {
      if (!line.endsWith(']')) {
        throw new TomlError('unterminated table header', lineNumber);
      }
      const path = splitPath(line.slice(1, -1).trim(), lineNumber);
      let node = root;
      for (const segment of path) {
        const existing = node[segment];
        if (existing === undefined) {
          const created: TomlTable = {};
          node[segment] = created;
          node = created;
        } else if (typeof existing === 'object' && !Array.isArray(existing)) {
          node = existing;
        } else {
          throw new TomlError(`"${segment}" is already a value, not a table`, lineNumber);
        }
      }
      // A table created implicitly by `[a.b]` may still be defined once as
      // `[a]`; an explicit header may never appear twice.
      if (definedTables.has(node)) {
        throw new TomlError(`table [${path.join('.')}] is defined more than once`, lineNumber);
      }
      definedTables.add(node);
      current = node;
      currentPath = path;
      continue;
    }

    const equals = line.indexOf('=');
    if (equals < 0) {
      throw new TomlError(`expected key = value, got "${line}"`, lineNumber);
    }
    const rawKey = line.slice(0, equals).trim();
    const key = rawKey.startsWith('"') ? parseString(rawKey, lineNumber) : rawKey;
    if (!rawKey.startsWith('"') && !/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new TomlError(`invalid key "${key}"`, lineNumber);
    }
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      throw new TomlError(`duplicate key "${key}"`, lineNumber);
    }

    let raw = line.slice(equals + 1).trim();
    // Multi-line arrays: keep consuming lines until the brackets balance.
    // Comments are already stripped per line, so they can appear between
    // entries as usual.
    if (raw.startsWith('[') && bracketDepth(raw) > 0) {
      let depth = bracketDepth(raw);
      while (depth > 0) {
        index += 1;
        if (index >= lines.length) {
          throw new TomlError('unterminated array', lineNumber);
        }
        const continuation = stripComment(lines[index] ?? '').trim();
        raw += ` ${continuation}`;
        depth += bracketDepth(continuation);
      }
    }
    const value = parseValue(raw, lineNumber);
    if (typeof value === 'number' && !INTEGER.test(raw.trim())) {
      options.onFloat?.([...currentPath, key]);
    }
    current[key] = value;
  }

  return root;
}

export function asTable(value: TomlValue | undefined, label: string): TomlTable {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a table`);
  }
  return value;
}
