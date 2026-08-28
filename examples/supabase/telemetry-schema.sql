-- Example project-local telemetry storage for ores-otel/ws-ingest/v1.
-- Rename the schema for each product/org when sharing one Postgres cluster.
-- Apply through declarative-migrations; do not run this from a browser client.

begin;

create schema if not exists ores_telemetry;

revoke all on schema ores_telemetry from public, anon, authenticated;
grant usage on schema ores_telemetry to service_role;

create table if not exists ores_telemetry.session_logs (
  record_id text primary key,
  batch_id text not null,
  batch_sequence bigint not null check (batch_sequence >= 1),
  subject_id uuid not null,
  app_name text not null check (length(app_name) between 1 and 128),
  runtime text not null check (length(runtime) between 1 and 64),
  session_id text not null check (length(session_id) between 1 and 256),
  client_instance_id text not null check (length(client_instance_id) between 1 and 256),
  app_version text,
  release text,
  occurred_at timestamptz not null,
  log_record jsonb not null,
  ingested_at timestamptz not null default statement_timestamp(),
  constraint record_id_length check (length(record_id) between 1 and 256),
  constraint batch_id_length check (length(batch_id) between 1 and 256),
  constraint log_record_schema check (log_record ->> 'schema' = 'next-loggers/v1')
);

create index if not exists session_logs_subject_session_idx
  on ores_telemetry.session_logs (subject_id, session_id, ingested_at desc);

create index if not exists session_logs_app_time_idx
  on ores_telemetry.session_logs (app_name, ingested_at desc);

create index if not exists session_logs_trace_idx
  on ores_telemetry.session_logs ((log_record ->> 'traceId'))
  where log_record ? 'traceId';

alter table ores_telemetry.session_logs enable row level security;
alter table ores_telemetry.session_logs force row level security;
revoke all on ores_telemetry.session_logs from public, anon, authenticated;
grant select, insert on ores_telemetry.session_logs to service_role;

comment on table ores_telemetry.session_logs is
  'Server-only, idempotent ores-otel session logs. The Edge Function derives subject_id from a consumed ticket and ACKs only after commit.';
comment on column ores_telemetry.session_logs.record_id is
  'Stable client idempotency key. Replays use ON CONFLICT (record_id) DO NOTHING.';
comment on column ores_telemetry.session_logs.subject_id is
  'Derived from verified server-side ticket claims; never trusted from the WebSocket batch.';

commit;

-- Edge Function transaction pattern (pseudocode; execute with server-only credentials):
--
--   begin;
--   insert into ores_telemetry.session_logs (...)
--   values (...)
--   on conflict (record_id) do nothing;
--   -- accepted = inserted rows; duplicates = batch size - accepted
--   commit;
--   -- send commit_ack only after COMMIT succeeds, with exact batch_id/sequence
--
-- No policy intentionally permits direct browser inserts. A service-role key is
-- acceptable only inside the trusted Edge Function/server and must never be
-- returned in the one-time WebSocket ticket response.
