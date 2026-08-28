# Durable browser telemetry over Supabase WebSockets

`PersistentSupabaseWebSocketIngestTransport` wraps the ticketed WebSocket ingest transport with a synchronous replay queue. It persists each sanitized log record and its stable `recordId` **before** socket enqueue, and removes it only after the ingest service returns the matching post-transaction `commit_ack`.

This is an at-least-once protocol. A browser can receive an acknowledgement and crash before clearing its local queue, so the database must make `record_id` unique and treat a replay as a duplicate rather than a second log row.

## Browser setup

```ts
import { createPersistentSupabaseWebSocketIngestTransport } from
  '@oresoftware/next-loggers/supabase-websocket-persistent';

const transport = createPersistentSupabaseWebSocketIngestTransport({
  storage: window.sessionStorage,
  storageKey: 'my-product:telemetry:v1',
  session: {
    appName: 'my-product-web',
    runtime: 'browser',
    sessionId: pseudonymousSessionId,
    clientInstanceId: perInstallClientId,
    appVersion: BUILD_VERSION,
    release: RELEASE_SHA,
  },
  allowedHosts: ['project-ref.functions.supabase.co'],
  ticketProvider: async () => {
    const response = await fetch('/api/telemetry-ticket', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`telemetry ticket failed: ${response.status}`);
    }
    return response.json();
  },
  maxPersistedRecords: 2_000,
  maxPersistedAgeMillis: 24 * 60 * 60 * 1_000,
});
```

Use `sessionStorage` by default: it is per tab, synchronous, and naturally discarded when the tab is closed. `localStorage` is allowed through the same interface, but callers must use a session-specific key and explicitly clear it on logout because it is shared across tabs and user sessions.

`write()` normally returns after durable local enqueue. Set `awaitAcknowledgement: true` only when the caller must wait for a database commit. `flush()` drains all persisted records and resolves only after commit acknowledgements. A failed drain leaves stable IDs and records in storage for reload replay.

## Required server boundary

The browser receives only a short-lived, one-time ticket minted by the application backend. Never expose a Supabase service-role key, secret key, database password, or long-lived access token to this transport.

The Supabase Edge Function must:

1. validate and atomically consume the ticket;
2. derive the authenticated subject and authorized project from server-side ticket claims—not from the batch payload;
3. validate the `ores-otel/ws-ingest/v1` batch and `next-loggers/v1` records;
4. insert records in one database transaction using `record_id` as the idempotency key;
5. count inserted and duplicate rows so `accepted + duplicates` equals the batch size;
6. commit the transaction; and
7. only then send the exact `commit_ack` for the batch ID and sequence.

A WebSocket send, a Supabase Realtime broadcast acknowledgement, or an HTTP 2xx generated before the transaction commits is not a durable acknowledgement.

Each application/project should write to its own Supabase project or namespaced schema/table. The example migration at `examples/supabase/telemetry-schema.sql` denies direct `anon` and `authenticated` table access; the trusted ingest function is the only writer.

## Privacy and retention

Persist only records that have already passed the logger's redaction policy. Do not place passwords, authorization headers, cookies, raw payment data, private message bodies, precise location, or secret material in `values`, `fields`, or user context. Prefer pseudonymous session and client IDs, document retention limits, and honor application telemetry opt-out before constructing the transport.

The replay state is bounded by record count, age, and per-record byte size. Corrupt, expired, cross-session, duplicate-ID, or oversized entries are dropped and reported through the persistent diagnostics callbacks.

## Zed lifecycle gates

The repository's `.zed/pre-build` hook type-checks the transport and runs both WebSocket suites. `.zed/pre-publish` invokes the pre-build gate, contract validation, runtime tests, polyglot tests, and release checks. Projects consuming the transport should mirror those gates with `.zed/` or `.zpkg/` lifecycle files and lock dependencies through Zed.
