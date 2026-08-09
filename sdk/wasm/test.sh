#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
if command -v rustup >/dev/null 2>&1; then
  cargo=(rustup run stable cargo)
  export RUSTC
  RUSTC=$(rustup which rustc --toolchain stable)
  export RUSTDOC
  RUSTDOC=$(rustup which rustdoc --toolchain stable)
else
  cargo=(cargo)
fi

"${cargo[@]}" fmt --manifest-path "$root/Cargo.toml" -- --check
"${cargo[@]}" test --manifest-path "$root/Cargo.toml" --locked
"${cargo[@]}" build --manifest-path "$root/Cargo.toml" --target wasm32-unknown-unknown --locked
