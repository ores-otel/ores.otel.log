# Supabase session telemetry

`@oresoftware/next-loggers/observability` provides two complementary client
transports:

- `SupabaseIngestTransport` batches authenticated `next-loggers/v1` records to
  the `telemetry-ingest` Edge Function for authoritative Postgres storage.
- `SupabaseRealtimeAckTransport` broadcasts records over a private Supabase
  Realtime channel and waits for the matching Phoenix acknowledgement.
- `SupabaseSessionTransport` mirrors records to both. The durable Edge Function
  path remains authoritative when Realtime is unavailable.

A Realtime acknowledgement proves that the Realtime server received a
broadcast. It does **not** prove that a Postgres row was committed. Do not use a
Realtime-only transport for audit trails, billing, security evidence, or any
other durable record.

## Browser and JavaScript setup

```ts
import { createBrowserLogger } from '@oresoftware/next-loggers/browser';
import {
  createSupabaseSessionTransport,
} from '@oresoftware/next-loggers/observability';

const sessionId = crypto.randomUUID();

const supabaseTransport = createSupabaseSessionTransport({
  url: import.meta.env.PUBLIC_SUPABASE_URL,
  publishableKey: import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  accessToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token;
  },
  session: {
    appName: 'customer-web',
    sessionId,
  },
  realtime: {
    // Keep live-tail work bounded. The durable ingest path still persists when
    // this retry budget is exhausted.
    maxReconnectAttempts: 10,
    maxQueueSize: 2_000,
    maxInFlight: 16,
  },
  ingest: {
    batchSize: 50,
    maxQueueSize: 2_000,
    maxRecordBytes: 128 * 1024,
    maxBatchBytes: 480 * 1024,
    flushIntervalMillis: 1_000,
  },
  onRealtimeError(error, snapshot) {
    // Report a bounded local health signal. Never recursively feed the same
    // error into this transport.
    telemetryHealth = { error: String(error), ...snapshot };
  },
});

export const logger = createBrowserLogger({
  appName: 'customer-web',
  console: false,
  fields: { release: import.meta.env.PUBLIC_RELEASE_SHA },
  transports: [supabaseTransport],
});
```

`SupabaseSessionTransport` verifies that every record uses the configured
`appName` and copies the configured opaque `sessionId` into `fields.sessionId`.
Its default private Realtime topic is scoped to that app/session. The server
still derives the authenticated user from the JWT; client-supplied identity
fields are never an authorization source.

## Credential boundary

Distributed clients may contain only:

- a current `sb_publishable_*` key, or a legacy anon key while migrating; and
- the signed-in user's access token.

Never ship an `sb_secret_*` key, a `service_role` key/JWT, a database password,
or a backend-only secret in JavaScript, Flutter, WASM, desktop, or mobile
configuration. The transports reject obvious elevated credentials before
network delivery.

Authenticated ingestion is required by default. Set `allowUnauthenticated:
true` only for a deliberately public endpoint with independent abuse controls.
Private Realtime channels should have Realtime Authorization policies that bind
the topic to the authenticated user/session.

## Delivery and failure semantics

The acknowledged Realtime transport:

- retains a record until the server replies to its exact Phoenix `ref`;
- replays unacknowledged records with the same stable record ID after reconnect;
- limits queued and in-flight records;
- drops the oldest waiting record on queue overflow and reports the reason;
- bounds broadcast attempts and connection retries;
- refreshes the user token by invoking the access-token callback for each new
  connection;
- detects missing heartbeat acknowledgements;
- uses capped exponential backoff with jitter;
- makes `flush()` and `close()` explicit, bounded operations; and
- does not patch `fetch`, `WebSocket`, console methods, or global telemetry
  providers.

The durable ingest transport independently enforces record, batch, queue,
timeout, keepalive, and retry limits. Postgres deduplicates by stable record ID,
so a reconnect or a repeated HTTP batch does not create duplicate rows.

## Flutter, Rust, Leptos, Dioxus, and WASM

All native SDKs emit the same `next-loggers/v1` record. Apply these rules across
runtimes:

- Flutter/Dart: use the Dart SDK's application-injected Supabase sender for the
  authenticated Edge Function; attach `fields.sessionId` from the login/device
  session. Use `supabase_flutter` Realtime only as an optional live-tail mirror.
- Rust services: use the Rust SDK and OTEL bridge for traces/metrics/logs; send
  durable client-session records through a server-owned adapter or the same
  Edge Function contract. Service-role credentials stay server-side.
- Leptos/Dioxus/Mash browser or WASM code: use the WASM SDK/host callback and
  the browser's user token. Do not embed server credentials in the WASM bundle.
- Server-rendered frontends: correlate the browser session ID with request trace
  context, but keep browser and server authorization boundaries separate.

## Per-project storage

Apply the reference migrations separately in every consuming Supabase project.
That gives each project/org its own `telemetry_private.next_logger_events` table.
The Edge Function's `TELEMETRY_ALLOWED_APP_NAMES` environment variable is a
server-side allowlist; clients cannot select a table or impersonate another
application namespace.

For a deliberately shared Supabase project, route only through a reviewed
server-side app registry. Do not accept a client-provided schema or table name.
Use `app_name`, the authenticated `user_id`, and indexed `session_id` for
partitioning/querying, or deploy separate schemas/functions per tenant.

## Deploy the reference endpoint

Copy `examples/supabase` into the consuming Supabase project, then:

```sh
supabase db push
supabase secrets set \
  TELEMETRY_ALLOWED_ORIGINS='https://app.example.com' \
  TELEMETRY_ALLOWED_APP_NAMES='customer-web,customer-flutter' \
  TELEMETRY_MAX_RECORDS_PER_MINUTE='1000'
supabase functions deploy telemetry-ingest
```

Keep JWT verification enabled. Query the private table only from trusted
backend infrastructure, SQL tooling, or a separately authorized API. Configure
bounded retention and never log bearer tokens, cookies, authorization headers,
payment data, raw request/response bodies, or unreviewed personal data.
