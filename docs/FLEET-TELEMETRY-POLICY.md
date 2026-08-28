# ORE fleet telemetry policy

This policy applies to production repositories and their `*-test` mirrors.
Adoption should be staged in the test org first and promoted only after the
consumer's exact-head checks pass.

## Required architecture

1. Emit the canonical `next-loggers/v1` record through the runtime-native
   `ores-otel/ores.otel.log` SDK.
2. Correlate every browser/mobile login or device session with an opaque
   `fields.sessionId`; correlate server work with W3C trace/span context.
3. Persist client-session logs through the authenticated Supabase Edge Function.
   Realtime Broadcast is an optional acknowledged live-tail mirror, not the
   durable system of record.
4. Deploy the private telemetry schema separately in each project's Supabase
   project. A shared project requires a reviewed server-side app registry;
   clients never choose table/schema names.
5. Keep publishable keys and user JWTs in clients. Keep service-role, secret,
   database, and collector credentials in server-only secret stores.
6. Redact credentials, cookies, payment data, raw bodies, and unnecessary
   personal data before any transport receives the record.
7. Bound queues, records, batches, retry attempts, reconnect attempts, flushes,
   retention, and per-user ingest rates. Expose drop/failure counters through a
   non-recursive health path.
8. Deduplicate by stable record ID and preserve that ID across HTTP retry and
   WebSocket replay.

## Runtime adoption

| Runtime | Canonical package/target | Required client-session path |
| --- | --- | --- |
| JavaScript/TypeScript browser | `nodejs` target / browser entry | `SupabaseSessionTransport` |
| Rust server | `rust` target | OTEL plus authenticated durable adapter |
| Rust WASM / Leptos / Dioxus browser | `rust-wasm` target | host callback using user JWT; optional Realtime mirror |
| Dart / Flutter | `dart` target | SDK sender to `telemetry-ingest`; attach `sessionId` |
| Go, Java, Python, Ruby, BEAM | matching native target | OTEL/server sink; never distributed service-role credentials |

## Zed package management

Every consuming repository should declare `ores-otel/ores.otel.log` in
`.zpkg.toml`, select the narrowest runtime target, commit the generated lockfile,
and make CI verify that the manifest and lock resolve to the reviewed version.
Do not vendor copied logger implementations or point production dependencies at
an unreviewed branch. Test-org canaries may pin a candidate commit/package before
promotion.

A source-policy check should fail when a session-capable frontend:

- has no canonical ORE logger dependency;
- contains a Supabase secret/service-role credential pattern;
- sends client telemetry only through Realtime;
- omits a session identifier or app allowlist;
- accepts a client-provided table/schema name; or
- changes `.zpkg.toml` without the corresponding reviewed lock update.

## Pull-request audit checklist

Review each outstanding PR for telemetry-sensitive changes: authentication,
request/session context, background work, HTTP/WebSocket clients, error handling,
logging, tracing, Supabase, Flutter lifecycle, and dependency manifests. Add a
PR comment only when it identifies an attributable gap or records exact evidence;
do not spam unrelated PRs with a generic template.
