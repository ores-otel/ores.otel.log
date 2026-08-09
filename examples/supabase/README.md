# Supabase telemetry-ingest reference deployment

This example provides the server half of
`@oresoftware/next-loggers/supabase-ingest`:

- a private Postgres storage schema;
- a service-role-only ingestion RPC;
- atomic per-user per-minute quotas;
- idempotency on `(user_id, app_name, record_id)`;
- a bounded retention/pruning RPC;
- an authenticated Edge Function with strict CORS and payload limits.

## Install

Copy `migrations/0001_next_logger_ingest.sql`, `functions/telemetry-ingest`, and
the function stanza from `config.toml` into the target Supabase project. Then:

```sh
supabase db push
supabase secrets set \
  TELEMETRY_ALLOWED_ORIGINS='https://app.example.com,https://admin.example.com' \
  TELEMETRY_MAX_RECORDS_PER_MINUTE='1000'
supabase functions deploy telemetry-ingest
```

Supabase provides the project URL, publishable/secret key sets, and JWKS to Edge
Functions. Keep JWT verification enabled. Never copy a secret or legacy
service-role key into browser, Flutter, desktop, or other distributed client
configuration.

The function imports `@supabase/server@^1`; generate and commit the Deno lockfile
in the consuming Supabase project so deployment uses a reviewed immutable
resolution:

```sh
cd supabase/functions/telemetry-ingest
deno install
deno check index.ts
```

## Retention

Run pruning repeatedly in bounded chunks. With `pg_cron`, a 30-day example is:

```sql
select cron.schedule(
  'prune-next-logger-events',
  '*/10 * * * *',
  $$select public.prune_next_logger_events(interval '30 days', 10000);$$
);
```

Choose retention based on contractual, privacy, legal, and incident-response
requirements. High-volume installations should partition
`telemetry_private.next_logger_events` by `received_at` before production load.

## Querying

The tables are intentionally outside the exposed Data API. Query them from
trusted backend infrastructure, SQL tooling, Grafana/Postgres, or a separately
authorized server API. Do not weaken the schema grants merely to make browser
queries convenient.
# Supabase telemetry-ingest reference

This example is an authenticated storage boundary for
`@oresoftware/next-loggers/supabase-ingest`.

## Layout

- `functions/telemetry-ingest/index.ts`: user-authenticated Edge Function using
  `@supabase/server@^1`; CORS preflight is handled by the wrapper.
- `migrations/202608020001_next_loggers_ingest.sql`: RLS-protected tables,
  validation, per-user quota, and idempotent ingestion RPC.
- `config.toml`: keeps JWT verification explicit.

## Deployment

Copy these files into the matching paths of a Supabase project, apply the
migration, test locally, and deploy `telemetry-ingest`. Client applications pass
only a publishable/legacy anon key plus the signed-in user's access token.
Never expose a secret or service-role credential.

The example quota is 1,000 attempted records per authenticated user per minute,
with a maximum of 100 records and 512 KiB per batch. Tune those values alongside
retention, product traffic, and abuse monitoring.
