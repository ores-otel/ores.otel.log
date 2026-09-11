#!/usr/bin/env python3
"""Repair the TypeScript context-clone accessor boundary fail-closed.

Run after the primary and follow-up async-context transformations. Standard
Error instances expose an own ``stack`` accessor in Node.js; that accessor must
never be invoked or copied into a synthetic Error object. Plain records with
own accessors are application-defined opaque handles and therefore remain
reference-stable instead of being partially cloned or rejected.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "src/context-shared.ts"


def replace_once(old: str, new: str) -> None:
    text = TARGET.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            f"src/context-shared.ts: expected one accessor-boundary fragment, found {count}"
        )
    TARGET.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    """function cloneOwnDataProperties(
  source: object,
  target: object,
  state: ContextCloneState,
  depth: number,
): void {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if (!(\'value\' in descriptor)) {
      throw new TypeError(\'context snapshots do not support accessor properties\');
    }
    Object.defineProperty(target, key, {
      ...descriptor,
      value: cloneContextValueInternal(descriptor.value, state, depth + 1),
    });
  }
}
""",
    """function hasOwnAccessorProperties(source: object): boolean {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor && !(\'value\' in descriptor)) return true;
  }
  return false;
}

function cloneOwnDataProperties(
  source: object,
  target: object,
  state: ContextCloneState,
  depth: number,
): void {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !(\'value\' in descriptor)) continue;
    Object.defineProperty(target, key, {
      ...descriptor,
      value: cloneContextValueInternal(descriptor.value, state, depth + 1),
    });
  }
}
""",
)

replace_once(
    """  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = Object.create(prototype) as object;
""",
    """  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (hasOwnAccessorProperties(object)) return value;
  const copy = Object.create(prototype) as object;
""",
)

print("async-context accessor boundary repaired")
