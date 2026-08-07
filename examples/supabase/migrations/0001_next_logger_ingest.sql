-- Durable, authenticated next-loggers ingestion for Supabase.
-- Apply with `supabase db push`; review retention and quota values first.

create schema if not exists telemetry_private;
revoke all on schema telemetry_private from public, anon, authenticated, service_role;

create table if not exists telemetry_private.next_logger_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id text not null check (char_length(batch_id) between 8 and 128),
  record_id text not null check (char_length(record_id) between 1 and 256),
  event_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  app_name text not null check (char_length(app_name) between 1 and 128),
  logger_name text check (logger_name is null or char_length(logger_name) <= 128),
  level text not null check (level in ('TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL')),
  runtime text not null check (char_length(runtime) between 1 and 64),
  trace_id text check (
    trace_id is null or (
      trace_id ~ '^[0-9a-f]{32}$' and trace_id <> repeat('0', 32)
    )
  ),
  span_id text check (
    span_id is null or (
      span_id ~ '^[0-9a-f]{16}$' and span_id <> repeat('0', 16)
    )
  ),
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  unique (user_id, app_name, record_id)
);

create index if not exists next_logger_events_user_time_idx
  on telemetry_private.next_logger_events (user_id, event_at desc);
create index if not exists next_logger_events_app_time_idx
  on telemetry_private.next_logger_events (app_name, event_at desc);
create index if not exists next_logger_events_trace_idx
  on telemetry_private.next_logger_events (trace_id)
  where trace_id is not null;
create index if not exists next_logger_events_received_idx
  on telemetry_private.next_logger_events (received_at);

alter table telemetry_private.next_logger_events enable row level security;
alter table telemetry_private.next_logger_events force row level security;
revoke all on telemetry_private.next_logger_events from public, anon, authenticated, service_role;

create table if not exists telemetry_private.next_logger_ingest_windows (
  user_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  record_count integer not null check (record_count >= 0),
  primary key (user_id, window_start)
);

alter table telemetry_private.next_logger_ingest_windows enable row level security;
alter table telemetry_private.next_logger_ingest_windows force row level security;
revoke all on telemetry_private.next_logger_ingest_windows from public, anon, authenticated, service_role;

create or replace function public.ingest_next_logger_records(
  p_user_id uuid,
  p_batch_id text,
  p_records jsonb,
  p_max_records_per_minute integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, telemetry_private
as $$
declare
  v_requested integer;
  v_window_count integer;
  v_inserted integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'user id is required';
  end if;
  if p_batch_id is null or p_batch_id !~ '^nl-[0-9]+-[0-9a-f]{16}$' then
    raise exception using errcode = '22023', message = 'invalid telemetry batch id';
  end if;
  if jsonb_typeof(p_records) <> 'array' then
    raise exception using errcode = '22023', message = 'records must be a JSON array';
  end if;

  v_requested := jsonb_array_length(p_records);
  if v_requested < 1 or v_requested > 100 then
    raise exception using errcode = '22023', message = 'batch must contain between 1 and 100 records';
  end if;
  if split_part(p_batch_id, '-', 2)::integer <> v_requested then
    raise exception using errcode = '22023', message = 'batch id record count mismatch';
  end if;
  if octet_length(p_records::text) > 524288 then
    raise exception using errcode = '22023', message = 'batch exceeds 512 KiB';
  end if;
  if p_max_records_per_minute < 1 or p_max_records_per_minute > 100000 then
    raise exception using errcode = '22023', message = 'invalid telemetry rate limit';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_records) as item(record)
    where jsonb_typeof(record) is distinct from 'object'
       or octet_length(record::text) > 131072
       or record->>'schema' is distinct from 'next-loggers/v1'
       or jsonb_typeof(record->'id') is distinct from 'string'
       or coalesce(char_length(record->>'id'), 0) not between 1 and 256
       or jsonb_typeof(record->'timestamp') is distinct from 'string'
       or coalesce(char_length(record->>'timestamp'), 0) not between 1 and 64
       or jsonb_typeof(record->'appName') is distinct from 'string'
       or coalesce(char_length(record->>'appName'), 0) not between 1 and 128
       or jsonb_typeof(record->'runtime') is distinct from 'string'
       or coalesce(char_length(record->>'runtime'), 0) not between 1 and 64
       or jsonb_typeof(record->'message') is distinct from 'string'
       or coalesce(char_length(record->>'message'), 0) > 16384
       or jsonb_typeof(record->'level') is distinct from 'string'
       or coalesce(record->>'level', '') not in ('TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL')
       or jsonb_typeof(record->'fields') is distinct from 'object'
       or jsonb_typeof(record->'values') is distinct from 'array'
       or (
         record ? 'traceId' and record->>'traceId' is not null and (
           lower(record->>'traceId') !~ '^[0-9a-f]{32}$'
           or lower(record->>'traceId') = repeat('0', 32)
         )
       )
       or (
         record->'fields' ? 'otel.span_id' and record->'fields'->>'otel.span_id' is not null and (
           lower(record->'fields'->>'otel.span_id') !~ '^[0-9a-f]{16}$'
           or lower(record->'fields'->>'otel.span_id') = repeat('0', 16)
         )
       )
  ) then
    raise exception using errcode = '22023', message = 'batch contains an invalid next-loggers record';
  end if;

  begin
    perform (record->>'timestamp')::timestamptz
    from jsonb_array_elements(p_records) as item(record);
  exception when others then
    raise exception using errcode = '22023', message = 'batch contains an invalid timestamp';
  end;

  if exists (
    select 1
    from jsonb_array_elements(p_records) as item(record)
    where (record->>'timestamp')::timestamptz < v_now - interval '365 days'
       or (record->>'timestamp')::timestamptz > v_now + interval '10 minutes'
  ) then
    raise exception using errcode = '22023', message = 'batch timestamp is outside the accepted window';
  end if;

  insert into telemetry_private.next_logger_ingest_windows (
    user_id,
    window_start,
    record_count
  ) values (
    p_user_id,
    date_trunc('minute', v_now),
    v_requested
  )
  on conflict (user_id, window_start)
  do update set record_count = telemetry_private.next_logger_ingest_windows.record_count + excluded.record_count
  returning record_count into v_window_count;

  if v_window_count > p_max_records_per_minute then
    -- Raising rolls back the counter update and the entire batch atomically.
    raise exception using errcode = 'P0001', message = 'telemetry rate limit exceeded';
  end if;

  insert into telemetry_private.next_logger_events (
    user_id,
    batch_id,
    record_id,
    event_at,
    app_name,
    logger_name,
    level,
    runtime,
    trace_id,
    span_id,
    record
  )
  select
    p_user_id,
    p_batch_id,
    record->>'id',
    (record->>'timestamp')::timestamptz,
    record->>'appName',
    nullif(record->>'name', ''),
    record->>'level',
    record->>'runtime',
    nullif(lower(record->>'traceId'), ''),
    nullif(lower(record->'fields'->>'otel.span_id'), ''),
    record
  from jsonb_array_elements(p_records) as item(record)
  on conflict (user_id, app_name, record_id) do nothing;

  get diagnostics v_inserted = row_count;

  return jsonb_build_object(
    'accepted', v_inserted,
    'duplicates', v_requested - v_inserted,
    'requested', v_requested,
    'batchId', p_batch_id
  );
end;
$$;

revoke all on function public.ingest_next_logger_records(uuid, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.ingest_next_logger_records(uuid, text, jsonb, integer)
  to service_role;

create or replace function public.prune_next_logger_events(
  p_retention interval default interval '30 days',
  p_limit integer default 10000
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, telemetry_private
as $$
declare
  v_deleted integer;
begin
  if p_retention < interval '1 hour' or p_retention > interval '365 days' then
    raise exception using errcode = '22023', message = 'retention must be between 1 hour and 365 days';
  end if;
  if p_limit < 1 or p_limit > 100000 then
    raise exception using errcode = '22023', message = 'invalid prune limit';
  end if;

  with expired as (
    select id
    from telemetry_private.next_logger_events
    where received_at < clock_timestamp() - p_retention
    order by received_at
    limit p_limit
    for update skip locked
  )
  delete from telemetry_private.next_logger_events as events
  using expired
  where events.id = expired.id;

  get diagnostics v_deleted = row_count;

  delete from telemetry_private.next_logger_ingest_windows
  where window_start < clock_timestamp() - interval '2 hours';

  return v_deleted;
end;
$$;

revoke all on function public.prune_next_logger_events(interval, integer)
  from public, anon, authenticated;
grant execute on function public.prune_next_logger_events(interval, integer)
  to service_role;

comment on function public.ingest_next_logger_records(uuid, text, jsonb, integer) is
  'Authenticated Edge Function RPC for bounded, idempotent next-loggers ingestion.';
comment on function public.prune_next_logger_events(interval, integer) is
  'Deletes a bounded batch of expired telemetry records; schedule from trusted infrastructure.';
