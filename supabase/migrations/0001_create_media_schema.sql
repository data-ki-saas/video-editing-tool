create table if not exists public.users (
    id uuid primary key references auth.users (id) on delete cascade,
    email text,
    display_name text,
    avatar_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.projects (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references public.users (id) on delete cascade,
    name text not null,
    timeline jsonb not null default '{"tracks":[]}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.assets (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects (id) on delete cascade,
    uploaded_by uuid not null references public.users (id) on delete cascade,
    filename text not null,
    kind text not null check (kind in ('video', 'image')),
    mime_type text not null check (mime_type in ('video/mp4', 'image/jpeg', 'image/png')),
    size_bytes bigint not null check (size_bytes > 0),
    storage_key text not null unique,
    public_url text not null,
    created_at timestamptz not null default now()
);

create index if not exists projects_owner_id_idx on public.projects (owner_id);
create index if not exists assets_project_id_idx on public.assets (project_id);
create index if not exists assets_uploaded_by_idx on public.assets (uploaded_by);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
    insert into public.users (id, email, display_name, avatar_url)
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
        new.raw_user_meta_data ->> 'avatar_url'
    )
    on conflict (id) do update set
        email = excluded.email,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        updated_at = now();
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

alter table public.users enable row level security;
alter table public.projects enable row level security;
alter table public.assets enable row level security;

create policy "Users can view their own profile"
    on public.users for select using (auth.uid() = id);
create policy "Users can update their own profile"
    on public.users for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "Users can view their own projects"
    on public.projects for select using (auth.uid() = owner_id);
create policy "Users can create their own projects"
    on public.projects for insert with check (auth.uid() = owner_id);
create policy "Users can update their own projects"
    on public.projects for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "Users can delete their own projects"
    on public.projects for delete using (auth.uid() = owner_id);

create policy "Project owners can view assets"
    on public.assets for select using (
        exists (select 1 from public.projects where projects.id = assets.project_id and projects.owner_id = auth.uid())
    );
create policy "Project owners can add assets"
    on public.assets for insert with check (
        uploaded_by = auth.uid()
        and exists (select 1 from public.projects where projects.id = assets.project_id and projects.owner_id = auth.uid())
    );
create policy "Project owners can delete assets"
    on public.assets for delete using (
        exists (select 1 from public.projects where projects.id = assets.project_id and projects.owner_id = auth.uid())
    );