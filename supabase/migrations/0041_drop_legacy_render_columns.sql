-- Server-side (Creatomate) rendering was removed; export is now local in the
-- browser, which never writes render tracking to the database. No cloud
-- render ever completed, so these columns hold no data worth keeping.
drop index if exists public.projects_render_id_idx;

alter table public.projects
    drop column if exists render_id,
    drop column if exists render_status,
    drop column if exists render_url,
    drop column if exists render_error,
    drop column if exists render_started_at,
    drop column if exists render_output_duration_seconds;
