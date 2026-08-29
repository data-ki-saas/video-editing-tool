-- Talking-avatar video generation (see backend/src/avatar/) -- lip-syncs a
-- narration audio asset (this app's own TTS output) to a chosen avatar via
-- a third-party provider (HeyGen). Async: a row here tracks one in-flight
-- (or finished) generation between the initial request and the provider's
-- webhook delivery.
create table if not exists public.avatar_generations (
    -- The provider's own video id, reused directly as this row's id -- a
    -- webhook delivery only ever carries the provider's id, so there's
    -- never a second id to map between (see repository.py's
    -- get_generation_by_id).
    id text primary key,
    project_id uuid not null references public.projects (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    avatar_id text not null,
    status text not null default 'waiting' check (status in ('waiting', 'completed', 'failed')),
    -- Set once the webhook stores the finished video as a real asset (kind
    -- 'video') -- null until then, and forever if the generation failed.
    asset_id uuid references public.assets (id) on delete set null,
    error text,
    created_at timestamptz not null default now()
);

create index if not exists avatar_generations_user_id_idx on public.avatar_generations (user_id);

alter table public.avatar_generations enable row level security;

-- Backend-owned like niche_configs/usage_events: only the service role
-- (which bypasses RLS) ever writes this table -- see
-- core/supabase_client.py's own comment. No insert/update/delete policy for
-- authenticated users; select-own is included for defense-in-depth/future
-- direct-read use, even though today's polling goes through the backend's
-- own GET /api/avatar/generations/{id}, not a direct Supabase read.
create policy "Users can view their own avatar generations"
    on public.avatar_generations for select using (auth.uid() = user_id);

-- Widen usage_events (0006_create_usage_events.sql) to cover avatar-video
-- generations too, so avatar/repository.py's daily-cap check can reuse the
-- same table/pattern as tts's voiceover cap instead of a parallel one.
alter table public.usage_events drop constraint usage_events_event_type_check;
alter table public.usage_events add constraint usage_events_event_type_check
    check (event_type in ('render', 'voiceover', 'upload', 'avatar_video'));
