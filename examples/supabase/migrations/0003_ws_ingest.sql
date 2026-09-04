-- ores-otel/ws-ingest/v1: commit-acknowledged WebSocket ingest (see docs/supabase-websocket-ingest-v1.md).
-- Adds one-time ticket consumption and an idempotent batch commit RPC that returns the commit_ack body.

create table if not exists telemetry_private.ws_tickets_consumed (
  nonce        text        primary key check (char_length(nonce) between 16 and 128),
  user_id      uuid        not null,
  app_name     text        not null,
  consumed_at  timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null
);
alter table telemetry_private.ws_tickets_consumed enable row level security;
alter table telemetry_private.ws_tickets_consumed force row level security;
revoke all on telemetry_private.ws_tickets_consumed from public, anon, authenticated, service_role;
create index if not exists ws_tickets_consumed_expires_idx on telemetry_private.ws_tickets_consumed (expires_at);

create table if not exists telemetry_private.ws_batches (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  app_name     text        not null check (char_length(app_name) between 1 and 128),
  batch_id     text        not null check (char_length(batch_id) between 8 and 128),
  sequence     bigint      not null check (sequence >= 0),
  record_count integer     not null check (record_count between 1 and 500),
  content_hash text        not null check (content_hash ~ '^[0-9a-f]{64}$'),
  accepted     integer     not null check (accepted >= 0),
  duplicates   integer     not null check (duplicates >= 0),
  committed_at timestamptz not null default clock_timestamp(),
  primary key (user_id, app_name, batch_id)
);
alter table telemetry_private.ws_batches enable row level security;
alter table telemetry_private.ws_batches force row level security;
revoke all on telemetry_private.ws_batches from public, anon, authenticated, service_role;

-- Consume a one-time ticket nonce. Returns true the first time, false on replay.
create or replace function public.consume_telemetry_ws_ticket(p_nonce text, p_user_id uuid, p_app_name text, p_expires_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, telemetry_private
as $$
begin
  if p_nonce is null or p_user_id is null or p_app_name is null or p_expires_at is null then
    raise exception using errcode = '22023', message = 'ticket fields are required';
  end if;
  if p_expires_at < clock_timestamp() then
    return false;
  end if;
  insert into telemetry_private.ws_tickets_consumed (nonce, user_id, app_name, expires_at)
  values (p_nonce, p_user_id, p_app_name, p_expires_at)
  on conflict (nonce) do nothing;
  return found;
end;
$$;
revoke all on function public.consume_telemetry_ws_ticket(text, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.consume_telemetry_ws_ticket(text, uuid, text, timestamptz) to service_role;

-- Idempotent batch commit. The same (user, app, batch_id) with the same content returns the stored
-- acknowledgement; different content for a known batch id is an error (never silently re-accepted).
create or replace function public.ingest_telemetry_ws_batch(
  p_user_id uuid, p_app_name text, p_runtime text, p_batch_id text, p_sequence bigint, p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, telemetry_private
as $$
declare
  v_hash text;
  v_existing telemetry_private.ws_batches%rowtype;
  v_requested integer;
  v_inserted integer := 0;
  v_rec jsonb;
  v_record jsonb;
  v_level text;
begin
  if p_user_id is null or p_app_name is null or p_batch_id is null or p_sequence is null then
    raise exception using errcode = '22023', message = 'batch identity fields are required';
  end if;
  if jsonb_typeof(p_records) <> 'array' then
    raise exception using errcode = '22023', message = 'records must be a JSON array';
  end if;
  v_requested := jsonb_array_length(p_records);
  if v_requested < 1 or v_requested > 500 then
    raise exception using errcode = '22023', message = 'batch must contain between 1 and 500 records';
  end if;
  v_hash := encode(sha256(convert_to(p_records::text, 'UTF8')), 'hex');

  select * into v_existing from telemetry_private.ws_batches
   where user_id = p_user_id and app_name = p_app_name and batch_id = p_batch_id for update;
  if found then
    if v_existing.content_hash <> v_hash or v_existing.sequence <> p_sequence then
      raise exception using errcode = '23505', message = 'batch id reused with different contents';
    end if;
    return jsonb_build_object('batchId', p_batch_id, 'sequence', p_sequence,
      'accepted', 0, 'duplicates', v_existing.record_count, 'committedAt', v_existing.committed_at);
  end if;

  for v_rec in select value from jsonb_array_elements(p_records) loop
    v_record := v_rec->'record';
    if jsonb_typeof(v_record) <> 'object' or (v_rec->>'recordId') is null then
      raise exception using errcode = '22023', message = 'each item needs recordId and an object record';
    end if;
    v_level := upper(coalesce(v_record->>'level', 'INFO'));
    if v_level not in ('TRACE','DEBUG','INFO','WARN','ERROR','FATAL') then v_level := 'INFO'; end if;
    insert into telemetry_private.next_logger_events
      (user_id, batch_id, record_id, event_at, app_name, logger_name, level, runtime, trace_id, span_id, record)
    values (
      p_user_id, p_batch_id, v_rec->>'recordId',
      coalesce((v_record->>'timestamp')::timestamptz, (v_record->>'time')::timestamptz, clock_timestamp()),
      p_app_name, left(v_record->>'appName', 128), v_level, coalesce(p_runtime, 'unknown'),
      nullif(v_record->>'traceId', ''), nullif(v_record->>'spanId', ''), v_record)
    on conflict (user_id, app_name, record_id) do nothing;
    if found then v_inserted := v_inserted + 1; end if;
  end loop;

  insert into telemetry_private.ws_batches (user_id, app_name, batch_id, sequence, record_count, content_hash, accepted, duplicates)
  values (p_user_id, p_app_name, p_batch_id, p_sequence, v_requested, v_hash, v_inserted, v_requested - v_inserted);

  return jsonb_build_object('batchId', p_batch_id, 'sequence', p_sequence,
    'accepted', v_inserted, 'duplicates', v_requested - v_inserted, 'committedAt', clock_timestamp());
end;
$$;
revoke all on function public.ingest_telemetry_ws_batch(uuid, text, text, text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_telemetry_ws_batch(uuid, text, text, text, bigint, jsonb) to service_role;
