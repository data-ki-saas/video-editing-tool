-- Public, revocable "view + download this rendered reel" links -- no
-- sharing mechanism existed before this. The public lookup-by-token path is
-- deliberately NOT covered by an RLS policy here: it's served exclusively
-- through the service-role client (same precedent as the Creatomate webhook
-- route, which also has no user session to check against). RLS below only
-- governs the OWNER managing their own shares from the editor.
create table if not exists public.project_shares (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects (id) on delete cascade,
    token text not null unique,
    created_at timestamptz not null default now(),
    revoked_at timestamptz
);

create index if not exists project_shares_project_id_idx on public.project_shares (project_id);
create index if not exists project_shares_token_idx on public.project_shares (token);

alter table public.project_shares enable row level security;

create policy "Project owners can view their shares"
    on public.project_shares for select using (
        exists (select 1 from public.projects where projects.id = project_shares.project_id and projects.owner_id = auth.uid())
    );
create policy "Project owners can create shares"
    on public.project_shares for insert with check (
        exists (select 1 from public.projects where projects.id = project_shares.project_id and projects.owner_id = auth.uid())
    );
create policy "Project owners can revoke their shares"
    on public.project_shares for update using (
        exists (select 1 from public.projects where projects.id = project_shares.project_id and projects.owner_id = auth.uid())
    );
