# Runtime-boundary peer-authority canary

This directory is an incremental DEN-3959 contract canary for cross-language/runtime boundaries.

- `main.tsp` is an independently maintained TypeSpec authority.
- `authored.schema.json` is an independently maintained JSON Schema Draft 2020-12 authority.
- neither source is generated from or allowed to overwrite the other;
- `.typespec-json-schema-validator/generated/` contains comparison-only evidence;
- `instances/RuntimeBoundary/` is an independently maintained positive/negative corpus spanning Rust, Go, Dart/Flutter, and Gleam/BEAM runtime strategies.

CI invokes `ORESoftware/typespec-json-schema-validator` at immutable commit `a4b731fbf82c4d162abd74fd03758fa32bb76176`. That validator commit passed its own Ubuntu 24.04 and macOS 14 checks before adoption here. Any structural, declaration, differential-validation, corpus, or tool execution disagreement fails closed and blocks this canary.

This canary does not claim that every `ores.otel.log` contract has already migrated to dual peer authorities. It establishes the admission pattern for expanding the existing JSON Schema contract family without making generated schema a third authority.
