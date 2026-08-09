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
