-- Add an indexed, queryable user-session key without trusting it for ownership.
-- Ownership remains the authenticated user_id derived by the Edge Function.

alter table telemetry_private.next_logger_events
  add column if not exists session_id text
  generated always as (
    nullif(record #>> '{fields,sessionId}', '')
  ) stored;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'next_logger_events_session_id_length'
      and conrelid = 'telemetry_private.next_logger_events'::regclass
  ) then
    alter table telemetry_private.next_logger_events
      add constraint next_logger_events_session_id_length
      check (session_id is null or char_length(session_id) between 1 and 128);
  end if;
end;
$$;

create index if not exists next_logger_events_user_session_time_idx
  on telemetry_private.next_logger_events (user_id, session_id, event_at desc)
  where session_id is not null;

comment on column telemetry_private.next_logger_events.session_id is
  'Opaque client-session correlation key extracted from record.fields.sessionId; never an authorization source.';
