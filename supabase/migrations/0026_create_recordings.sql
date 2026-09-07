-- A user's own raw camera recordings/photos (CameraCapturePage.tsx, the
-- Record button at dashboard/[projectId]/record) -- a personal, cross-
-- project library distinct from both `assets` (per-project, tied to one
-- reel's timeline) and `library_videos` (a finished deliverable render).
-- Reachable via the spool icon next to Library in TopMenuBar; pulled into a
-- specific project's assets via the "+Asset" popup's Recordings tab, which
-- copies the underlying bytes into a fresh `assets` row rather than sharing
-- storage_key across the two tables (see
-- backend/src/recordings/service.py's add_to_project) -- editing or
-- deleting a recording later never affects a reel it was already added to.
--
-- Lives in the private uploads bucket (r2_client's default client,
-- presigned URLs), same as `assets` -- raw personal footage, not a finished
-- deliverable, so it does NOT belong in the public renders bucket
-- library_videos uses.
create table if not exists public.recordings (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    name text not null,
    description text check (char_length(description) <= 120),
    kind text not null check (kind in ('video', 'image')),
    mime_type text not null check (mime_type in ('video/mp4', 'image/jpeg')),
    size_bytes bigint not null check (size_bytes > 0),
    storage_key text not null unique,
    duration_seconds numeric,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- desc so the recordings page's own "newest first" listing is a straight
-- index scan, not a sort (same reasoning as library_videos_user_time_idx).
create index if not exists recordings_user_time_idx on public.recordings (user_id, created_at desc);

alter table public.recordings enable row level security;

-- Backend-owned like library_videos/avatar_generations: only the service
-- role (which bypasses RLS) ever writes this table. No insert/update/delete
-- policy for authenticated users; select-own is included for
-- defense-in-depth/future direct-read use.
create policy "Users can view their own recordings"
    on public.recordings for select using (auth.uid() = user_id);
