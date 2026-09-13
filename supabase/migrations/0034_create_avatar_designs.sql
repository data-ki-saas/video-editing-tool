-- A creator's own generated avatar Design + Skin (avatar plan doc's Phase 6
-- -- photo -> parametric skin), backend-service-role-owned like
-- avatar_generations/background_removals (0013/0019): only the backend ever
-- writes this table. Deliberately NOT shaped like avatar_generations (the
-- retired HeyGen job-status table) -- there's no async job/webhook here,
-- generation is synchronous, so this is just the finished result. `skin`/
-- `design` store the exact AvatarSkin/AvatarDesign JSON
-- frontend/src/lib/video/avatar/compile.ts already validates -- their
-- `atlas.imageRef`/`meta.thumbnail` fields are left blank in storage and
-- only ever filled in with a fresh presigned URL at read time (see
-- backend/src/avatar_gen/service.py's `_resolve`), never persisted, since a
-- resolved R2 URL expires (same reasoning as
-- frontend/src/lib/timeline/resolve.ts's own `_appMeta` pattern).
create table if not exists public.avatar_designs (
    id text primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    name text not null,
    skin jsonb not null,
    design jsonb not null,
    atlas_key text not null,
    created_at timestamptz not null default now()
);

create index if not exists avatar_designs_user_time_idx on public.avatar_designs (user_id, created_at desc);

alter table public.avatar_designs enable row level security;

create policy "Users can view their own avatar designs"
    on public.avatar_designs for select using (auth.uid() = user_id);
