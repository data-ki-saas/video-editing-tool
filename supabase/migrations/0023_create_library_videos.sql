-- A user's saved/finished reels (see LocalRenderPopup.tsx's "Save to
-- library" button, next to Download) -- distinct from `projects` (the
-- editable timeline) and `usage_ledger`/`assets`: a row here is a
-- standalone finished deliverable the user explicitly chose to keep, so it
-- survives its source project being deleted later (project_id goes null;
-- project_name is a snapshot taken at save time so the entry still reads
-- sensibly with no project to join against).
create table if not exists public.library_videos (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    project_id uuid references public.projects (id) on delete set null,
    project_name text not null,
    video_url text not null,
    thumbnail_url text,
    duration_seconds numeric,
    -- Set via the library page's own "Save as template" action button on an
    -- already-saved video -- a personal shortlist within the library, not a
    -- separate table, since a template IS a library video (same
    -- video_url/thumbnail_url), just flagged. Filtered client-side today
    -- (see /library's own Templates tab); an index isn't worth it yet at
    -- POC-scale per-user row counts.
    is_template boolean not null default false,
    created_at timestamptz not null default now()
);

-- desc so the library page's own "newest first" listing is a straight
-- index scan, not a sort.
create index if not exists library_videos_user_time_idx on public.library_videos (user_id, created_at desc);

alter table public.library_videos enable row level security;

-- Backend-owned like avatar_generations/background_removals (0013/0019):
-- only the service role (which bypasses RLS) ever writes this table -- see
-- core/supabase_client.py's own comment. No insert/update/delete policy for
-- authenticated users; select-own is included for defense-in-depth/future
-- direct-read use, even though today's /library page reads through the
-- backend's own GET /api/library, not a direct Supabase read.
create policy "Users can view their own library videos"
    on public.library_videos for select using (auth.uid() = user_id);
