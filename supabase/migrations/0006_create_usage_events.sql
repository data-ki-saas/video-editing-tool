-- Login-gating alone doesn't stop a signed-in user from running up render/
-- storage costs -- this is a plain count-in-last-24h abuse guardrail, not a
-- metering/billing system (no plans, no tiers, just a fixed daily cap
-- checked in application code before each expensive operation).
create table if not exists public.usage_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    event_type text not null check (event_type in ('render', 'voiceover', 'upload')),
    created_at timestamptz not null default now()
);

create index if not exists usage_events_user_type_time_idx
    on public.usage_events (user_id, event_type, created_at);

alter table public.usage_events enable row level security;

-- Append-only: no update/delete policy, same precedent as assets having no
-- update policy -- a usage record is never edited or removed by a client.
create policy "Users can view their own usage events"
    on public.usage_events for select using (auth.uid() = user_id);
create policy "Users can record their own usage events"
    on public.usage_events for insert with check (auth.uid() = user_id);
