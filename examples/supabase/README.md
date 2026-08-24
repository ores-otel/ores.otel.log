# Supabase telemetry-ingest reference deployment

This example is the durable, authenticated storage boundary for
`@oresoftware/next-loggers/observability`.

It provides:

- a non-exposed `telemetry_private` schema;
- a service-role-only ingestion RPC called only by the Edge Function;
- authenticated user ownership derived from the verified JWT;
- atomic per-user rate limiting;
- stable-record idempotency;
- an indexed generated `session_id` for user-session queries;
- strict origin and app-name allowlists; and
- bounded retention/pruning.

Realtime Broadcast is a separate live-tail path. Realtime acknowledgements are
not a substitute for this durable insert boundary.

## Install

Copy this directory into the consuming Supabase project. Keep only the canonical
`0001_next_logger_ingest.sql` migration plus later numbered migrations; the
removed timestamped migration used a conflicting public-table design.

```sh
supabase db push
supabase secrets set \
  TELEMETRY_ALLOWED_ORIGINS='https://app.example.com,https://admin.example.com' \
  TELEMETRY_ALLOWED_APP_NAMES='customer-web,customer-flutter' \
  TELEMETRY_MAX_RECORDS_PER_MINUTE='1000'
supabase functions deploy telemetry-ingest
```

JWT verification must remain enabled. Browser, Flutter, desktop, and WASM code
receive only a publishable/legacy anon key plus the signed-in user's access
token. Never distribute a secret or service-role key.

The function imports `@supabase/server@^1`. Generate and commit the Deno lockfile
in the consuming project so deployment uses a reviewed immutable resolution:

```sh
cd supabase/functions/telemetry-ingest
deno install
deno check index.ts
```

## Project isolation

Deploy these objects once per Supabase project/org. The table name is fixed
server-side. `TELEMETRY_ALLOWED_APP_NAMES` further restricts which `appName`
values that project accepts. A client cannot select a schema/table or write under
an unapproved application name.

A deliberately shared Supabase project needs a reviewed server-side routing
registry or separate schemas/functions. Never implement dynamic SQL from a
client-supplied table name.

## Retention

Run pruning repeatedly in bounded chunks. With `pg_cron`, a 30-day example is:

```sql
select cron.schedule(
  'prune-next-logger-events',
  '*/10 * * * *',
  $$select public.prune_next_logger_events(interval '30 days', 10000);$$
);
```

Choose retention based on privacy, contractual, legal, and incident-response
requirements. High-volume installations should review time partitioning before
production load.

## Querying

The tables are outside the exposed Data API. Query them from trusted backend
infrastructure, SQL tooling, Grafana/Postgres, or a separately authorized API.
Do not weaken grants merely to make browser queries convenient.
