# Agent guidelines for ores.otel.log

This repository is polyglot (TypeScript core in `src/`, native SDKs under `sdk/`). Read the
relevant `docs/` page before changing a contract; keep every SDK's public API source-compatible
because downstream repositories (for example ores-middleware) pin this repository by git rev.

Repository rules:

- Build values, don't mutate them: functions return new values instead of filling `&mut`/pointer
  parameters or caller-owned collections; every language. Deliberate exceptions on hot paths carry a
  `HOT-PATH (imperative by design)` comment with the reason. See [`docs/FUNCTIONAL-STYLE.md`](./docs/FUNCTIONAL-STYLE.md).
