-- A log of daily-cap-exceeded events, distinct from usage_events (0006 --
-- the pass/fail counter each cap check reads) and usage_ledger (0016 -- the
-- real cost ledger): this is purely an admin-visible warning trail so a cap
-- being hit repeatedly (a possible cost-overrun signal) shows up somewhere
-- other than Render's raw server logs. Written only by trusted server-side
-- code (the backend's service-role client), same convention as usage_ledger
-- -- no policies, so a user-scoped client can't insert or read one.
create table if not exists public.cap_warnings (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    feature text not null check (feature in ('render', 'voiceover', 'avatar_video', 'background_removal')),
    cap_value int not null,
    count_at_trigger int not null,
    created_at timestamptz not null default now()
);

create index if not exists cap_warnings_time_idx on public.cap_warnings (created_at desc);

alter table public.cap_warnings enable row level security;
-- No policies -- service-role only, same convention as role_features (0015)
-- and usage_ledger (0016).
