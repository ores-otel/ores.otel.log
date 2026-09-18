# Compatibility consumer inventory

Inventory date: 2026-09-14.

The canonical development/release repository is `ores-otel/ores.otel.log`. This remote is retained for compatibility and historical links.

Current ORESoftware references found outside this repository include:

- `ORESoftware/ores-middleware`, whose TypeScript OTel adapter imports `@oresoftware/next-loggers`.
- `ORESoftware/ores-cli`, whose logging-chain hygiene documentation recognizes the `@oresoftware/next-loggers` ESLint/plugin surface.
- repositories carrying copied `.ores-lint` plugin configuration may still recognize `@oresoftware/next-loggers` as a compatibility module name; those copies are consumers of the package identity, not evidence that this remote is canonical.

The legacy Go module identity `github.com/ORESoftware/next-loggers.ts/sdk/go` is retained inside this mirror and its compatibility tests. The contract manifests already record the canonical Go identity as `github.com/ores-otel/ores.otel.log/sdk/go`.

Consumers must move new Git/development references to the canonical repository. Existing compatibility package names may remain pinned while registry/module migration is completed. New SDK families or release channels must be added only in the canonical repository.
