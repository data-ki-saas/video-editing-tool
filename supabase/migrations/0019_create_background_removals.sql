-- AI background removal for video cutaways/compositing (see
-- backend/src/matting/) -- cuts a subject out of an existing video clip via
-- a third-party matting provider (VEED, via fal.ai), producing a grayscale
-- luma-matte video that Creatomate's maskMode: "luma" composites against a
-- new backdrop. Async, mirrors avatar_generations (0013) exactly, except
-- keyed by source_asset_id (unique) rather than per-request: the same clip
-- trimmed into multiple cutaways/segments shares one matting job instead of
-- re-running (and re-billing) it for each use.
create table if not exists public.background_removals (
    -- The provider's own job id, reused directly as this row's id -- a
    -- webhook delivery only ever carries the provider's id, so there's
    -- never a second id to map between (see repository.py's get_by_id).
    id text primary key,
    source_asset_id uuid not null unique references public.assets (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    status text not null default 'waiting' check (status in ('waiting', 'completed', 'failed')),
    -- Set once the webhook stores the finished matte as a real asset (kind
    -- 'video') -- null until then, and forever if the job failed.
    matte_asset_id uuid references public.assets (id) on delete set null,
    error text,
    created_at timestamptz not null default now()
);

create index if not exists background_removals_user_id_idx on public.background_removals (user_id);

alter table public.background_removals enable row level security;

-- Backend-owned like avatar_generations: only the service role (which
-- bypasses RLS) ever writes this table. No insert/update/delete policy for
-- authenticated users; select-own is included for defense-in-depth/future
-- direct-read use, same precedent as 0013.
create policy "Users can view their own background removals"
    on public.background_removals for select using (auth.uid() = user_id);

-- Widen usage_events (0006_create_usage_events.sql) to cover
-- background-removal jobs too, so matting/repository.py's daily-cap check
-- can reuse the same table/pattern as avatar's own cap.
alter table public.usage_events drop constraint usage_events_event_type_check;
alter table public.usage_events add constraint usage_events_event_type_check
    check (event_type in ('render', 'voiceover', 'upload', 'avatar_video', 'background_removal'));

-- feature_key is validated against backend/src/permissions/features.py's
-- registry, not an FK -- see 0015's own comment on that choice. Granted to
-- admin/paid_user only, same tier as avatar_generate (0015's own
-- "free_user is withheld render/tts/avatar" grouping).
insert into public.role_features (role_key, feature_key)
values ('admin', 'matting_generate'), ('paid_user', 'matting_generate')
on conflict do nothing;
