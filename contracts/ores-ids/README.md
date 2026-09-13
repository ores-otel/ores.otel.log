# ores-trace / ores-routine identifier contract

This directory is the peer-authority contract for the two correlation identifiers every
`ores.otel.log` SDK attaches to a log event.

| Identifier | Pattern | Attached by |
| --- | --- | --- |
| `OresTraceId` | `^ores-trace-[A-Za-z0-9_-]{21}$` | `addTraceId` / `addTrace` (TS), `add_trace_id` / `add_trace` (Rust, Python), `AddTraceID` / `AddTrace` (Go), `addTrace` (Java, Dart), `add_trace` (Elixir) |
| `OresRoutineId` | `^ores-routine-[A-Za-z0-9_-]{21}$` | `addRoutineId` (TS, Java, Dart), `add_routine_id` (Rust, Python, Elixir), `AddRoutineID` (Go) |

- `main.tsp` is an independently authored TypeSpec authority.
- `authored.schema.json` is an independently authored JSON Schema Draft 2020-12 authority.
- Neither is generated from the other. TJSV output under `.typespec-json-schema-validator/` is
  comparison-only evidence and never a third authority.
- `instances/<Declaration>/{valid,invalid}/` is the positive/negative corpus. Every file is a single
  JSON value.

The convention the contract encodes is documented in
[`../../docs/ores-trace-and-routine-ids.md`](../../docs/ores-trace-and-routine-ids.md).

## Verify locally

```sh
npx --yes --package=github:ORESoftware/typespec-json-schema-validator#eac61635922c244c7a37829c63d0966de44ff800 \
  tjsv check \
  --typespec=contracts/ores-ids/main.tsp \
  --schema=contracts/ores-ids/authored.schema.json \
  --instances=contracts/ores-ids/instances
```

CI runs the same command in `.github/workflows/tjsv-ores-ids.yml`. Any structural, declaration,
differential-validation, or corpus disagreement fails closed.
