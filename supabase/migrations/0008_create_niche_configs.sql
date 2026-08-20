-- A shared, growing catalog of "what fields matter for this business niche"
-- (real estate, hospitality, auto, garments, gifts, hardware, or anything
-- typed in) -- generated once per niche by an LLM (see backend/src/niches/)
-- and reused by every user from then on. Deliberately NOT per-user: the
-- field schema for "auto dealership" isn't personal or sensitive, and
-- sharing avoids a redundant LLM call every time a new user picks a niche
-- someone else already used.
create table if not exists public.niche_configs (
    id uuid primary key default gen_random_uuid(),
    niche_key text not null unique,
    display_name text not null,
    -- Array of {key, label, type, required} -- a UI scaffold for the "New
    -- Reel" form, not an enforced schema: projects.attributes stays a
    -- freeform jsonb column regardless of what fields were suggested here.
    fields jsonb not null default '[]'::jsonb,
    script_template text,
    created_by uuid references public.users (id) on delete set null,
    created_at timestamptz not null default now()
);

create index if not exists niche_configs_niche_key_idx on public.niche_configs (niche_key);

alter table public.niche_configs enable row level security;

-- Readable by any signed-in user (it's a shared catalog); insertable by any
-- signed-in user too, since the get-or-create flow lets whoever first needs
-- a niche generate and cache it. No update/delete policy for POC -- if a
-- generated schema needs fixing, that's a manual admin task for now, not a
-- user-facing edit flow.
create policy "Signed-in users can view niche configs"
    on public.niche_configs for select using (auth.role() = 'authenticated');
create policy "Signed-in users can create niche configs"
    on public.niche_configs for insert with check (auth.role() = 'authenticated');
