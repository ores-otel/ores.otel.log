# Public mirror provenance

This directory is a read-only distribution mirror for consumer CI.

Canonical ownership remains in `ores-otel/ores-otel-interfaces` at merged commit:

`a24258ffb6bd6577f733382c18b1a4290ad29388`

The mirrored files are byte-for-byte copies of:

- `contracts/ores-error-trace.v1/main.tsp`
- `contracts/ores-error-trace.v1/authored.schema.json`

The canonical repository keeps the two independently human-authored authorities. This public mirror is not a third authority and must never be edited independently. Any change starts in `ores-otel-interfaces`, passes `ORESoftware/typespec-json-schema-validator` there, merges there, and only then updates this mirror to the new canonical commit.

`ores.otel.log` owns the transport/runtime mapping into this contract. `ORESoftware/ores-err-trace` owns normalization, fingerprinting and dedupe semantics. The mirror must not add fingerprint fields or provider-specific metadata.
