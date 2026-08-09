# Durable Supabase ingestion for browser and mobile clients

`@oresoftware/next-loggers/supabase-ingest` batches already-redacted
`next-loggers/v1` records to an authenticated Supabase Edge Function. It is the
durable client path. The existing Realtime transport may be added separately
for live tailing, but Realtime broadcast is not treated as durable storage.

## Security boundary

Client code may contain a publishable key (or a legacy anon key during
migration) and the signed-in user's access token. It must never contain:

- an `sb_secret_*` key;
- a `service_role` key or JWT;
- a backend database credential.

The transport rejects obvious elevated credentials. The reference Edge Function
uses `withSupabase({ auth: 'user' })`, so authentication and browser CORS
preflight handling occur before the handler. Its RPC uses the caller-scoped
Supabase client. The SQL function derives ownership from `auth.uid()` and never
trusts identity or role fields inside a log record.

## Client setup

```ts
import { createBrowserLogger } from '@oresoftware/next-loggers/browser';
import { createSupabaseIngestTransport } from '@oresoftware/next-loggers/supabase-ingest';

const transport = createSupabaseIngestTransport({
  url: import.meta.env.PUBLIC_SUPABASE_URL,
  publishableKey: import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  accessToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token;
  },
  batchSize: 50,
  maxQueueSize: 2_000,
  onDrop(drop) {
    // Record only the bounded reason/count in a separate local metric.
    observeDrop(drop.reason);
  },
  onError(error, snapshot) {
    reportLocalDiagnostic(error, snapshot);
  },
});

export const logger = createBrowserLogger({
  appName: 'web',
  console: false,
  transports: transport,
});
```

Authenticated ingestion is the default. `allowUnauthenticated` should be used
only for a deliberately publishable-key-only endpoint with independent abuse
controls.

## Batching and failure behavior

The transport:

- pre-serializes and bounds records, batches, the queue, and exit payloads;
- drops the oldest queued record on overflow and reports a bounded reason;
- preserves record order when a request fails;
- retries with capped exponential backoff and jitter;
- uses a deterministic batch ID for the same records on retry;
- uses `keepalive` only when the serialized exit request fits the configured
  budget;
- never reads or re-logs an error response body;
- isolates `onDrop` and `onError` callback failures;
- makes `close()` idempotent and stops accepting new records before draining.

The server migration additionally enforces record and batch sizes, validates the
wire schema, applies a transactional per-user quota, and deduplicates by
`(user_id, record_id)`.

## Deploy the reference endpoint

The deployable reference files are under `examples/supabase/`:

1. apply `migrations/202608020001_next_loggers_ingest.sql`;
2. copy `functions/telemetry-ingest` into the project's `supabase/functions/`;
3. copy the `telemetry-ingest` function stanza from `config.toml` so JWT
   verification remains explicit;
4. run the local Supabase function tests for the consuming project;
5. deploy the function and verify authenticated browser/mobile calls;
6. schedule retention for records and quota buckets according to policy.

The storage tables intentionally grant no direct access to `anon` or
`authenticated`. Only the validated RPC is executable by authenticated users.
