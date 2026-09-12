-- Durable, idempotent storage for next_log_batch_v1 collector commits.
-- Apply through the normal declarative-migrations path, never from a client.

create table if not exists public.next_logs (
  id text primary key,
  tenant_id uuid not null,
  session_id text not null,
  level text not null check (
    level in ('trace', 'debug', 'info', 'warn', 'error', 'fatal')
  ),
  occurred_at timestamptz not null,
  batch_id text not null,
  message text not null check (char_length(message) between 1 and 8192),
  attributes jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now(),
  constraint next_logs_attributes_object
    check (jsonb_typeof(attributes) = 'object')
);

create index if not exists next_logs_tenant_occurred_idx
  on public.next_logs (tenant_id, occurred_at desc);

create index if not exists next_logs_tenant_session_idx
  on public.next_logs (tenant_id, session_id, occurred_at desc);

create table if not exists public.next_log_batch_receipts (
  tenant_id uuid not null,
  batch_id text not null,
  event_count integer not null check (event_count between 1 and 200),
  committed_at timestamptz not null default now(),
  primary key (tenant_id, batch_id)
);

alter table public.next_logs enable row level security;
alter table public.next_log_batch_receipts enable row level security;

-- No direct anon/authenticated client policy is created intentionally. The
-- trusted collector writes with a server-side role after validating a short-
-- lived tenant-scoped ticket. Mobile clients never receive service-role keys.

comment on table public.next_logs is
  'Idempotent logs committed by the authenticated ores-otel WebSocket collector.';

comment on column public.next_logs.id is
  'Stable client event ID reused on replay and used for deduplication.';
