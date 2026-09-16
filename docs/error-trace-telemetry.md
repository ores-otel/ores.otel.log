# Error-trace telemetry

`ores.otel.log` emits the transport/correlation envelope admitted by `ores-otel/ores-otel-interfaces` `OresErrorTraceTelemetryV1`.

## Ownership

- `ores-otel/ores-otel-interfaces` owns the peer TypeSpec + JSON Schema transport contract.
- `ores.otel.log` owns runtime mapping from `LogRecord` into that contract.
- `ORESoftware/ores-err-trace` owns normalization, fingerprint construction, PostgreSQL atomic dedupe and the stable `DedupeRecordResult` boundary.
- CloudWatch, Google Cloud Logging, Loki/OTel Collector, Supabase/Neon and data-platform consumers are sinks/analysis planes. They preserve correlation fields but do not redefine the portable event.

## TypeScript API

Import from `@oresoftware/next-loggers/error-trace`:

```ts
import {
  buildErrorTraceTelemetry,
  buildOresTraceHeaders,
  readOresTraceIdHeader,
} from '@oresoftware/next-loggers/error-trace';

const event = buildErrorTraceTelemetry(logRecord, {
  environment: 'prod',
  repository: 'acme/payments-api',
  releaseSha: process.env.GIT_SHA,
  otelTraceId,
  otelSpanId,
});
```

The builder is functional: it returns a new value and never mutates the `LogRecord`. It only copies explicitly reviewed contract fields. Arbitrary `fields`, request bodies, auth headers, cookies, tokens and provider metadata are not copied into the portable event.

## Trace propagation

Authored ORES HTTP headers are lowercase. The canonical application-trace propagation header is:

`x-ores-trace-id`

Incoming HTTP header names are matched case-insensitively, as required by HTTP semantics. ORES application IDs (`ores-trace-*`) remain separate from native OpenTelemetry trace/span IDs.

## Dedupe semantics

Do not hash or dedupe in this package. Send the contract-shaped event to the error-trace ingestion boundary and let `ores-err-trace` choose the explicitly requested fingerprint policy. Preferred v1 deliberately excludes trace IDs and release SHA from the fingerprint; they remain occurrence/correlation metadata.

Normal occurrence recording should remain lock-free at the distributed-lock layer and rely on PostgreSQL `UNIQUE + ON CONFLICT` linearization. Only singleton external effects, alias reconciliation, compaction and resolve-once flows require a coordination intent/lock.

## Public contract mirror

`contracts/public/ores-error-trace.v1/` is a read-only distribution mirror of the canonical private interfaces repository. `PROVENANCE.md` pins the exact admitted source commit. The mirror is evidence/distribution only and must not be edited independently.
