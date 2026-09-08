-- A user's own saved teleprompter scripts (CameraCapturePage.tsx's
-- Teleprompter dialog) -- reachable from a "Script" button on /recordings,
-- listing/pasting/naming up to MAX_SCRIPTS_PER_USER (backend/src/scripts/
-- service.py) scripts that can each be sent straight into a fresh recording
-- (see /recordings/scripts's own "Record" card action, which preloads a
-- script's text the same way CameraCapturePage's own teleprompter-script
-- localStorage restore does). Distinct from that localStorage draft: this
-- table is the user's actual named, reusable script library, synced across
-- devices; the localStorage copy is only ever the last thing typed/pasted
-- into a live recording session's own popup.
create table if not exists public.scripts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    name text not null check (char_length(name) <= 100),
    -- ~450 words (backend/src/scripts/service.py's MAX_SCRIPT_WORDS, mirrors
    -- CameraCapturePage.tsx's own TELEPROMPTER_WORDS_PER_SECOND pacing) is
    -- the real cap on paste; this is only a generous byte-length backstop.
    text text not null check (char_length(text) <= 6000),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- desc so the scripts page's own "newest first" listing is a straight index
-- scan, not a sort (same reasoning as recordings_user_time_idx).
create index if not exists scripts_user_time_idx on public.scripts (user_id, created_at desc);

alter table public.scripts enable row level security;

-- Backend-owned like recordings/library_videos: only the service role
-- (which bypasses RLS) ever writes this table. No insert/update/delete
-- policy for authenticated users; select-own is included for
-- defense-in-depth/future direct-read use.
create policy "Users can view their own scripts"
    on public.scripts for select using (auth.uid() = user_id);
