alter table public.projects
    add column if not exists render_id text,
    add column if not exists render_status text,
    add column if not exists render_url text;

create index if not exists projects_render_id_idx on public.projects (render_id);
