create table if not exists public.public_library_assets (
    id text primary key,
    asset_type text not null check (asset_type in ('avatar', 'video', 'image', 'audio')),
    promoted_by uuid not null references public.users (id) on delete cascade,
    title text not null,
    description text,
    thumbnail_url text,
    -- Populated only when asset_type = 'avatar': an immutable snapshot of the
    -- source avatar_designs row's skin/design, with atlas.imageRef/
    -- meta.thumbnail already baked to a PERMANENT public-bucket URL (unlike
    -- avatar_designs itself, which leaves those blank and resolves a private
    -- presigned URL at read time -- see avatar_gen/service.py's
    -- resolve_avatar_record). A promoted avatar must keep working even if
    -- the original avatar_designs row is later renamed or deleted, so this
    -- is a copy, not a reference.
    avatar_skin jsonb,
    avatar_design jsonb,
    -- Reserved for a future image/video/audio promotion path -- not written
    -- by any endpoint yet (only avatars can be promoted today).
    media_url text,
    media_mime_type text,
    media_duration_seconds numeric,
    liability_waiver_accepted_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create index if not exists public_library_assets_type_time_idx
    on public.public_library_assets (asset_type, created_at desc);

alter table public.public_library_assets enable row level security;

-- Deliberately readable by every signed-in user, not just the promoter --
-- the entire point of this table is a browsable shared catalog (unlike
-- avatar_designs/library_videos, which are select-own). All writes go
-- through the backend's service-role client, so no insert/update/delete
-- policy is needed here (mirrors avatar_designs/library_videos).
create policy "Any signed-in user can browse the public asset library"
    on public.public_library_assets for select
    to authenticated
    using (true);
