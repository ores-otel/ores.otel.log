# Durable browser and client ingestion through Supabase

`@oresoftware/next-loggers/supabase-ingest` sends already-redacted
`next-loggers/v1` records to an authenticated Supabase Edge Function. It is the
durable client transport. The existing Supabase Realtime transport can be added
separately for live tailing, but Realtime is not used as the durable write path.

## Client setup

```ts
import { createBrowserLogger } from '@oresoftware/next-loggers/browser';
import { createSupabaseIngestTransport } from '@oresoftware/next-loggers/supabase-ingest';

const ingest = createSupabaseIngestTransport({
  url: 'https://PROJECT_REF.supabase.co',
  publishableKey: 'sb_publishable_...',
  accessToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token;
  },
  batchSize: 50,
  maxQueueSize: 2_000,
  maxRecordBytes: 128 * 1024,
  maxBatchBytes: 480 * 1024,
  flushIntervalMillis: 1_000,
  onDrop(drop) {
    // Increment a local bounded counter; do not recursively send the dropped
    // record back through this same transport.
    droppedTelemetry += 1;
  },
  onError(error, snapshot) {
    // Report through a distinct diagnostic path or user-visible health state.
    telemetryHealth = { error: String(error), ...snapshot };
  },
});

const logger = createBrowserLogger({
  appName: 'customer-web',
  console: false,
  transports: [ingest],
});
```

Authenticated ingestion is required by default. `allowUnauthenticated: true`
must be set explicitly for a deliberately public endpoint. The transport rejects
`sb_secret_*`, legacy service-role strings, and service-role JWTs before any
request is made.

## Delivery behavior

- records are serialized once and placed in a bounded cursor queue;
- oversized records are dropped before network delivery;
- queue overflow drops the oldest record so recent client state remains visible;
- ordinary batches respect record-count and byte budgets;
- failed batches are restored in their original order;
- retries use bounded exponential backoff with jitter;
- the deterministic batch ID is reused when the same batch is retried;
- request timeouts use `AbortController` without patching global `fetch`;
- response bodies are never reflected into client telemetry;
- `close()` is idempotent and uses a smaller exit/keepalive budget;
- writes after close are explicitly reported as bounded drops.

Set `awaitDelivery: true` only when a caller must await the HTTP result. Normal
browser logging should enqueue quickly and let `flush()`, the interval, or
`close()` perform delivery.

## Server deployment

The repository includes a hardened reference deployment under
`examples/supabase`:

1. apply `migrations/0001_next_logger_ingest.sql`;
2. configure allowed browser origins and the per-user rate limit;
3. deploy the `telemetry-ingest` Edge Function with JWT verification enabled;
4. schedule the bounded pruning function with the desired retention period.

The database objects live in a non-exposed `telemetry_private` schema. Clients
cannot call the ingestion RPC or read/write the tables directly. The Edge
Function authenticates the user and calls a service-role-only, security-definer
RPC that validates the batch, enforces an atomic per-user rate limit, and inserts
records idempotently.

## Privacy and data minimization

Client telemetry can contain personal or regulated information. Configure
`next-loggers` redaction before this transport, keep user objects minimal, and do
not add access tokens, cookies, authorization headers, payment data, or raw
request/response bodies to log fields.

The reference Edge Function never logs the bearer token or request body and does
not return raw Postgres errors. Use a separate server-side logger/OTEL pipeline
for ingestion-service diagnostics so a failure in client ingestion cannot
recursively ingest itself.
