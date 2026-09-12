#!/usr/bin/env python3
"""Apply the reviewed require-send wrapper-transfer hardening exactly once."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count == 1:
        target.write_text(text.replace(old, new, 1), encoding="utf-8")
        return
    if count == 0 and new in text:
        return
    raise RuntimeError(f"{path}: expected one source fragment, found {count}")


def remove_exactly(path: str, fragment: str, expected_count: int) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(fragment)
    if count == expected_count:
        target.write_text(text.replace(fragment, ""), encoding="utf-8")
        return
    if count == 0:
        return
    raise RuntimeError(
        f"{path}: expected {expected_count} removable fragments or zero after repair, found {count}"
    )


replace_once(
    ".ores-lint/require-send.mjs",
    """      '{': 'lbrace', '}': 'rbrace', ';': 'semi', ',': 'comma', '=': 'eq',
""",
    """      '{': 'lbrace', '}': 'rbrace', ';': 'semi', ',': 'comma', '=': 'eq', '&': 'amp',
""",
)

replace_once(
    ".ores-lint/require-send.mjs",
    """  return seen ? args + 1 : 0;
}

function walkMethodChain(tokens, start) {
""",
    """  return seen ? args + 1 : 0;
}

function matchingOpenParen(tokens, closeIndex) {
  if (tokens[closeIndex]?.type !== 'rparen') return -1;
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    if (tokens[i].type === 'rparen') depth += 1;
    else if (tokens[i].type === 'lparen') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function topLevelArgument(tokens, openIndex, closeIndex, wantedIndex) {
  if (tokens[openIndex]?.type !== 'lparen' || tokens[closeIndex]?.type !== 'rparen') return [];
  let depth = 0;
  let argumentIndex = 0;
  let start = openIndex + 1;
  for (let i = openIndex + 1; i < closeIndex; i++) {
    const token = tokens[i];
    if (token.type === 'lparen' || token.type === 'lbracket' || token.type === 'lbrace') {
      depth += 1;
    } else if (token.type === 'rparen' || token.type === 'rbracket' || token.type === 'rbrace') {
      depth = Math.max(0, depth - 1);
    } else if (token.type === 'comma' && depth === 0) {
      if (argumentIndex === wantedIndex) return tokens.slice(start, i);
      argumentIndex += 1;
      start = i + 1;
    }
  }
  return argumentIndex === wantedIndex ? tokens.slice(start, closeIndex) : [];
}

function directlyTransferredReceiverArgument(tokens, terminalIndex, language) {
  if (language === 'gleam') return '';
  if (tokens[terminalIndex - 1]?.type !== 'dot' || tokens[terminalIndex - 2]?.type !== 'rparen') {
    return '';
  }
  const closeIndex = terminalIndex - 2;
  const openIndex = matchingOpenParen(tokens, closeIndex);
  if (openIndex < 1) return '';

  // A wrapper result may be terminally delivered, for example
  // `apply_log_context(event, &context).send()`. Clear only a direct first
  // identifier argument. Borrowed (`&event`), cloned, nested, member, and
  // non-first arguments remain pending so the rule fails closed.
  const firstArgument = topLevelArgument(tokens, openIndex, closeIndex, 0);
  if (firstArgument.length !== 1 || firstArgument[0]?.type !== 'ident') return '';
  return firstArgument[0].value;
}

function walkMethodChain(tokens, start) {
""",
)

replace_once(
    ".ores-lint/require-send.mjs",
    """    // `name.send(...)` or `send(name)` / `logging.send(name)`
    if (tok.type === 'ident' && TERMINAL.has(tok.value)) {
      const prev = tokens[i - 1];
      if (prev?.type === 'dot' && tokens[i - 2]?.type === 'ident') {
        clear(qualifiedName(tokens, i - 2).name);
      }
      if (tokens[i + 1]?.type === 'lparen') {
        const inner = tokens[i + 2];
        if (inner?.type === 'ident') clear(inner.value);
      }
    }
""",
    """    // `name.send(...)`, `wrapper(name).send()`, or `send(name)` /
    // `logging.send(name)`. Wrapper transfer is intentionally conservative.
    if (tok.type === 'ident' && TERMINAL.has(tok.value)) {
      const prev = tokens[i - 1];
      if (prev?.type === 'dot' && tokens[i - 2]?.type === 'ident') {
        clear(qualifiedName(tokens, i - 2).name);
      } else {
        clear(directlyTransferredReceiverArgument(tokens, i, language));
      }
      if (tokens[i + 1]?.type === 'lparen') {
        const inner = tokens[i + 2];
        if (inner?.type === 'ident') clear(inner.value);
      }
    }
""",
)

replace_once(
    "tests/shutdown-runtime-coverage.test.mjs",
    """import { execFileSync, spawn } from 'node:child_process';
""",
    """import { spawn } from 'node:child_process';
""",
)

remove_exactly(
    "tests/supabase-realtime-portability.test.mjs",
    """  // eslint-disable-next-line no-undef
""",
    2,
)

print("require-send wrapper transfer hardening applied")
