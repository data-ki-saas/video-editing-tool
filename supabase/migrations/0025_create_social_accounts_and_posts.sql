-- Social-platform account connections (OAuth token storage, see
-- backend/src/social/) and one row per publish attempt. Backend-owned like
-- avatar_generations/library_videos: only the service role (which bypasses
-- RLS) ever writes these tables -- see core/supabase_client.py's own
-- comment. No insert/update/delete policy for authenticated users;
-- select-own is included for defense-in-depth/future direct-read use.
create table if not exists public.social_accounts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    -- More platforms (meta/tiktok) get added here later -- see
    -- social/providers/base.py's own comment on why this is a per-provider
    -- row per user, not a single global switch like llm_provider/tts_provider.
    provider text not null check (provider in ('youtube')),
    access_token text not null,
    refresh_token text not null,
    token_expires_at timestamptz not null,
    -- The provider's own account id/display name (YouTube channel id/title)
    -- -- shown in Settings so a user can tell which account is linked
    -- without a second API call.
    account_id text not null,
    account_name text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- One connected account per platform per user for v1 -- reconnecting
    -- upserts (see social/repository.py's upsert_account) rather than
    -- creating a second row.
    unique (user_id, provider)
);

alter table public.social_accounts enable row level security;

create policy "Users can view their own social accounts"
    on public.social_accounts for select using (auth.uid() = user_id);

-- One row per "Post to YouTube" click -- async-job shape mirrors
-- avatar_generations (0013), except there's no webhook here: our own
-- backend drives the upload directly (see social/service.py's
-- _run_publish) and writes its own terminal status instead of waiting for
-- a provider callback.
create table if not exists public.social_posts (
    id uuid primary key default gen_random_uuid(),
    library_video_id uuid not null references public.library_videos (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    provider text not null check (provider in ('youtube')),
    status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
    provider_video_id text,
    provider_url text,
    error text,
    created_at timestamptz not null default now()
);

create index if not exists social_posts_user_id_idx on public.social_posts (user_id);

alter table public.social_posts enable row level security;

create policy "Users can view their own social posts"
    on public.social_posts for select using (auth.uid() = user_id);

-- feature_key is validated against backend/src/permissions/features.py's
-- registry, not an FK -- see 0015's own comment on that choice. Same tier as
-- avatar_generate/render_generate (withheld from free_user).
insert into public.role_features (role_key, feature_key)
values ('admin', 'social_posting'), ('paid_user', 'social_posting')
on conflict do nothing;
