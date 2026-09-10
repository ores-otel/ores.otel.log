# Public mirror provenance

This directory is a read-only distribution mirror for consumer CI.

Canonical ownership remains in `ores-otel/ores-otel-interfaces` at merged commit:

`b544872d13323de7be19a9d5879c419149679f7a`

The mirrored files are byte-for-byte copies of:

- `contracts/ores-otel-config.v1/main.tsp`
- `contracts/ores-otel-config.v1/authored.schema.json`

The canonical repository keeps the two independently human-authored authorities. This public mirror is not a third authority and must never be edited independently. Any change starts in `ores-otel-interfaces`, passes TJSV there, merges there, and only then updates this mirror to the new canonical commit.

Consumer workflows pin an exact `ores.otel.log` commit containing this mirror and run `ORESoftware/typespec-json-schema-validator` against both mirrored peers plus the repository's parsed `.ores-otel.toml` instance.
