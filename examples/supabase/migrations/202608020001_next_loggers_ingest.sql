-- Authenticated, idempotent next-loggers ingestion for browser/mobile clients.
-- The public client never receives a secret/service-role key. The Edge Function
-- calls ingest_next_logger_batch with the caller's verified JWT/RLS context.

create table if not exists public.next_logger_records (
  user_id uuid not null,
  record_id text not null check (char_length(record_id) between 1 and 128),
  batch_id text not null check (char_length(batch_id) between 1 and 128),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  level text not null check (level in ('TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL')),
  runtime text not null check (char_length(runtime) between 1 and 64),
  app_name text not null check (char_length(app_name) between 1 and 128),
  trace_id text check (trace_id is null or trace_id ~ '^[0-9a-fA-F]{32}$'),
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  primary key (user_id, record_id)
);

create index if not exists next_logger_records_received_at_idx
  on public.next_logger_records (received_at desc);
create index if not exists next_logger_records_trace_id_idx
  on public.next_logger_records (trace_id)
  where trace_id is not null;
create index if not exists next_logger_records_user_occurred_idx
  on public.next_logger_records (user_id, occurred_at desc);

create table if not exists public.next_logger_ingest_quota (
  user_id uuid not null,
  bucket_start timestamptz not null,
  accepted integer not null check (accepted >= 0),
  primary key (user_id, bucket_start)
);

alter table public.next_logger_records enable row level security;
alter table public.next_logger_records force row level security;
alter table public.next_logger_ingest_quota enable row level security;
alter table public.next_logger_ingest_quota force row level security;

-- Clients cannot access the storage tables directly. The fixed-search-path
-- SECURITY DEFINER function below is the only authenticated write boundary.
revoke all on public.next_logger_records from anon, authenticated;
revoke all on public.next_logger_ingest_quota from anon, authenticated;

create or replace function public.ingest_next_logger_batch(
  p_batch_id text,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_count integer;
  v_total integer;
  v_inserted integer;
  v_record jsonb;
  v_timestamp timestamptz;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if p_batch_id is null or p_batch_id !~ '^[a-zA-Z0-9._:-]{1,128}$' then
    raise exception using errcode = '22023', message = 'invalid batch id';
  end if;
  if jsonb_typeof(p_records) <> 'array' then
    raise exception using errcode = '22023', message = 'records must be an array';
  end if;

  v_count := jsonb_array_length(p_records);
  if v_count < 1 or v_count > 100 then
    raise exception using errcode = '22023', message = 'batch size must be between 1 and 100';
  end if;
  if octet_length(p_records::text) > 512 * 1024 then
    raise exception using errcode = '22023', message = 'batch exceeds byte limit';
  end if;

  for v_record in select value from jsonb_array_elements(p_records)
  loop
    if jsonb_typeof(v_record) <> 'object'
      or v_record ->> 'schema' <> 'next-loggers/v1'
      or not (coalesce(char_length(v_record ->> 'id'), 0) between 1 and 128)
      or v_record ->> 'level' not in ('TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL')
      or not (coalesce(char_length(v_record ->> 'runtime'), 0) between 1 and 64)
      or not (coalesce(char_length(v_record ->> 'appName'), 0) between 1 and 128)
      or octet_length(v_record::text) > 128 * 1024
    then
      raise exception using errcode = '22023', message = 'invalid next-loggers record';
    end if;

    begin
      v_timestamp := (v_record ->> 'timestamp')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid record timestamp';
    end;

    if v_record ? 'traceId'
      and ((v_record ->> 'traceId') !~ '^[0-9a-fA-F]{32}$'
        or (v_record ->> 'traceId') ~ '^0{32}$')
    then
      raise exception using errcode = '22023', message = 'invalid trace id';
    end if;
  end loop;

  -- Transactional per-user quota. Raising below rolls the increment back.
  insert into public.next_logger_ingest_quota (user_id, bucket_start, accepted)
  values (v_user_id, date_trunc('minute', now()), v_count)
  on conflict (user_id, bucket_start)
  do update set accepted = public.next_logger_ingest_quota.accepted + excluded.accepted
  returning accepted into v_total;

  if v_total > 1000 then
    raise exception using errcode = 'P0001', message = 'telemetry ingest rate limit exceeded';
  end if;

  insert into public.next_logger_records (
    user_id,
    record_id,
    batch_id,
    occurred_at,
    level,
    runtime,
    app_name,
    trace_id,
    record
  )
  select
    v_user_id,
    item ->> 'id',
    p_batch_id,
    (item ->> 'timestamp')::timestamptz,
    item ->> 'level',
    item ->> 'runtime',
    item ->> 'appName',
    nullif(item ->> 'traceId', ''),
    item
  from jsonb_array_elements(p_records) as records(item)
  on conflict (user_id, record_id) do nothing;

  get diagnostics v_inserted = row_count;
  return jsonb_build_object(
    'accepted', v_inserted,
    'duplicates', v_count - v_inserted
  );
end;
$$;

revoke all on function public.ingest_next_logger_batch(text, jsonb) from public, anon;
grant execute on function public.ingest_next_logger_batch(text, jsonb) to authenticated;

comment on table public.next_logger_records is
  'Authenticated next-loggers/v1 client telemetry; ownership is derived from auth.uid().';
comment on function public.ingest_next_logger_batch(text, jsonb) is
  'Validates, rate-limits, and idempotently stores authenticated next-loggers batches.';

-- Schedule retention in infrastructure according to policy, for example:
-- delete from public.next_logger_records where received_at < now() - interval '30 days';
-- delete from public.next_logger_ingest_quota where bucket_start < now() - interval '1 day';
