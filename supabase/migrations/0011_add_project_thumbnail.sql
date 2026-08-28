-- Cover/thumbnail picker: thumbnail_url is a permanent, public R2 URL to a
-- standalone JPG/PNG the user downloads and attaches manually when
-- publishing to YouTube/TikTok/IG -- this app doesn't upload video anywhere
-- itself (see lib/localRender/exportTimeline.ts), so there's no video
-- container to embed a poster into. Written by backend/src/projects/
-- service.py's upload_thumbnail/clear_thumbnail only, NOT by the frontend
-- directly (unlike `timeline`) -- same reasoning as render_id/render_status/
-- render_url above: a backend-owned write needs to run alongside a real R2
-- object, so it stays out of the frontend's whole-object jsonb autosave.
-- thumbnail_source distinguishes a captured video frame from a manually
-- uploaded image; thumbnail_time_seconds is only meaningful when
-- thumbnail_source = 'frame' (lets the picker reopen at the same spot) and
-- is null for 'upload'.
alter table public.projects
    add column if not exists thumbnail_url text,
    add column if not exists thumbnail_source text check (thumbnail_source in ('frame', 'upload')),
    add column if not exists thumbnail_time_seconds numeric;
