/**
 * A strict, fail-closed reader for the TOML subset `.cli-flags.toml` uses.
 *
 * Deliberately NOT a general TOML parser. It supports exactly what the
 * flags-2-env format needs — tables, bare/quoted keys, basic strings,
 * integers, floats, booleans, and single-line arrays of strings — and throws
 * on anything else.
 *
 * Failing closed is the entire value here. The upstream C parser silently
 * ignores unknown sections and unknown keys, so `alias =` instead of
 * `aliases =` would slip through unnoticed; a lenient reader would let the
 * drift test pass while the contract quietly rotted.
 */

export type TomlValue = string | number | boolean | string[] | TomlTable;
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

function parseString(raw: string, lineNumber: number): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    throw new TomlError(`expected a double-quoted string, got ${raw}`, lineNumber);
  }
  const body = raw.slice(1, -1);
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      out += char;
      continue;
    }
    index += 1;
    const escape = body[index];
    switch (escape) {
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

function parseArray(raw: string, lineNumber: number): string[] {
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
  return items.map((item) => parseString(item, lineNumber));
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
  if (/^[+-]?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  if (/^[+-]?(\d+\.\d+|\d+[eE][+-]?\d+)$/.test(trimmed)) {
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

export function parseToml(input: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
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
      current = node;
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
    current[key] = parseValue(raw, lineNumber);
  }

  return root;
}

export function asTable(value: TomlValue | undefined, label: string): TomlTable {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a table`);
  }
  return value;
}
