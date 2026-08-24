# ORES Supabase commit-acknowledged WebSocket ingest v1

**Protocol:** `ores-otel/ws-ingest/v1`  
**Client module:** `@oresoftware/next-loggers/supabase-websocket-ingest`

This protocol streams user-session logs to an application’s own Supabase project without treating WebSocket delivery or Supabase Realtime Broadcast as durable storage. A client removes records only after the Edge Function returns an acknowledgement produced after the database transaction commits.

## Security boundary

The browser, Flutter, WASM, and desktop clients never receive a Supabase service-role key or `sb_secret_*` key. They request a short-lived, one-time ticket from their application backend. The ticket is scoped to one authenticated user, one project/tenant, one telemetry schema, one destination function, and a brief expiry.

The client accepts only `wss://` endpoints, rejects embedded URL credentials, and can enforce an exact hostname allow-list. The Edge Function validates the ticket before accepting a batch. Project membership and table access remain enforced by RLS and/or a security-definer RPC with a fixed `search_path` and explicit role checks.

Every application or organization owns its telemetry tables in its own Supabase project. Shared ORES code supplies the protocol and SDK; it does not centralize unrelated tenants into a global table.

## Handshake

After the WebSocket opens, the client sends:

```json
{
  "type": "hello",
  "protocol": "ores-otel/ws-ingest/v1",
  "ticket": "one-time-ticket",
  "session": {
    "appName": "example-app",
    "appVersion": "1.4.0",
    "runtime": "flutter",
    "sessionId": "pseudonymous-session-id",
    "clientInstanceId": "installation-id",
    "release": "2026.08.23"
  }
}
```

The server must consume the ticket exactly once. Ticket replay, expiry, tenant mismatch, schema mismatch, or a user without telemetry-write permission closes the connection.

## Batch

Only one batch is in flight per transport instance. The client keeps the exact batch in memory until commit acknowledgement:

```json
{
  "type": "telemetry_batch",
  "protocol": "ores-otel/ws-ingest/v1",
  "batchId": "batch-uuid",
  "sequence": 17,
  "sentAt": "2026-08-23T23:58:00.000Z",
  "session": { "appName": "example-app", "runtime": "browser", "sessionId": "...", "clientInstanceId": "..." },
  "records": [
    { "recordId": "record-uuid", "record": { "schema": "next-loggers/v1", "id": "..." } }
  ]
}
```

`batchId` is an idempotency key. The database must have a unique key at least on `(project_id, batch_id)`, and telemetry events should also be unique on `(project_id, event_id)` or `(project_id, record_id)`. A reconnect before acknowledgement resends the same batch ID, sequence, and record IDs.

## Commit acknowledgement

After the database transaction commits, the server sends:

```json
{
  "type": "commit_ack",
  "protocol": "ores-otel/ws-ingest/v1",
  "batchId": "batch-uuid",
  "sequence": 17,
  "accepted": 38,
  "duplicates": 2,
  "committedAt": "2026-08-23T23:58:00.120Z"
}
```

`accepted + duplicates` must equal the record count. The client rejects an acknowledgement with the wrong batch ID, wrong sequence, invalid counts, or wrong protocol. It leaves the batch in flight and can replay it. Realtime channel acknowledgement, socket write completion, or an HTTP `2xx` without this body is not a commit acknowledgement.

## Database transaction

A recommended Supabase RPC performs these operations atomically:

1. Validate `auth.uid()` and project membership.
2. Lock or insert `(project_id, batch_id)`.
3. If the batch already committed with the same session and count, return a duplicate acknowledgement.
4. Reject reuse of a batch ID with different contents.
5. Validate every record’s size, severity, timestamp, schema, session, and tenant.
6. Insert records with per-event uniqueness.
7. Commit the transaction.
8. Only then send `commit_ack` over the WebSocket.

The RPC should be `SECURITY DEFINER` only when necessary, pin `search_path`, revoke execution from `public`, and grant it narrowly to the intended authenticated role. Tables should have RLS enabled even when writes go through the RPC.

## Reconnect and backpressure

The SDK provides bounded queues, per-record byte limits, exponential reconnect delay, a maximum reconnect count, and drop/error diagnostics. It drops the oldest queued record when the queue is full, but never discards the in-flight batch. Applications should surface drop counters in local diagnostics and avoid placing secrets or unredacted sensitive fields in telemetry.

## Exit fallback

Browsers and mobile operating systems may suspend a process before a reconnect completes. `exitFallback.persist(batch)` sends the exact in-flight batch through an authenticated HTTPS Edge Function. The fallback must return the same `commit_ack` contract and use the same idempotency table; it is not allowed to generate a new batch ID.

## Runtime use

```ts
import { SupabaseWebSocketIngestTransport } from '@oresoftware/next-loggers/supabase-websocket-ingest';

const transport = new SupabaseWebSocketIngestTransport({
  ticketProvider: async () => fetch('/api/telemetry/ticket', { method: 'POST' }).then((response) => response.json()),
  allowedHosts: ['project.functions.supabase.co'],
  session: {
    appName: 'example-app',
    runtime: 'browser',
    sessionId,
    clientInstanceId,
  },
});
```

Rust, Dart/Flutter, Go, Java, and other ORES SDKs should implement the same wire contract and shared conformance fixtures. Zed packages should declare `ores-otel/ores.otel.log` as a dependency and run the language compiler/analyzer plus protocol fixtures in `pre-build` and `pre-publish` hooks.

## Verification boundary

The repository test suite uses an adversarial fake socket to verify post-commit retention, exact replay after disconnect, mismatched-ACK rejection, exact-batch exit fallback, and transport security checks. A real Supabase project test must additionally verify RLS, ticket replay rejection, RPC atomicity, duplicate batches, network interruption after commit but before ACK, and isolation between two projects/users.
