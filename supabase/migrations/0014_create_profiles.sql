-- First notion of a privileged user in this app: a role column, checked by
-- backend/src/core/auth.py's get_current_user() and require_admin(), and by
-- the frontend's useIsAdmin() hook to show/hide admin-only UI.
create table if not exists public.profiles (
    user_id uuid primary key references public.users (id) on delete cascade,
    role text not null default 'user' check (role in ('user', 'admin')),
    created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can view their own profile"
    on public.profiles for select using (auth.uid() = user_id);

-- No insert/update/delete policy for authenticated users: role changes are
-- a manual, service-role-only operation for now (same "manual admin task"
-- precedent as 0008_create_niche_configs.sql) -- promote a user to admin by
-- hand via the Supabase dashboard/SQL editor.

-- No signup trigger creates a row here on purpose: a user with no profiles
-- row is treated as role='user' everywhere this is checked -- fail CLOSED
-- (not-admin), the opposite of usage_events' fail-open convention, since
-- this gates access rather than just a usage count.
