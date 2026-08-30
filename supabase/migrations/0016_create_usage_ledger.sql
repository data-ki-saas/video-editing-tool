-- The metering/billing-basis ledger: unlike usage_events (0006 -- a plain
-- pass/fail count for the abuse-guardrail daily caps), this records the
-- actual consumed quantity (seconds/tokens) and an estimated cost for every
-- billable operation, captured at completion time with the real numbers
-- each provider returns. Written only by trusted server-side code (the
-- backend's service-role client, or the Creatomate webhook's service-role
-- client) -- never by a user-scoped client -- so no policy grants client
-- inserts; a user can't fabricate or suppress their own billing rows.
create table if not exists public.usage_ledger (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    project_id uuid references public.projects (id) on delete set null,
    event_type text not null check (event_type in ('render', 'voiceover', 'avatar_video', 'llm_completion')),
    provider text not null,
    external_ref text,
    quantity numeric not null,
    unit text not null check (unit in ('seconds', 'tokens')),
    cost_estimate_cents numeric(12, 6) not null default 0,
    status text not null default 'succeeded' check (status in ('succeeded', 'failed')),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists usage_ledger_user_time_idx on public.usage_ledger (user_id, created_at);
create index if not exists usage_ledger_type_time_idx on public.usage_ledger (event_type, created_at);

alter table public.usage_ledger enable row level security;
-- No policies -- service-role only, same convention as role_features (0015).
