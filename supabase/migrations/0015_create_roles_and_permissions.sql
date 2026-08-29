-- Generalizes profiles.role from a fixed check-constraint enum into
-- admin-creatable roles, each with its own set of granted feature keys (see
-- backend/src/permissions/features.py for the code-side registry -- feature
-- keys are validated against that list, not an FK, since a feature exists
-- because an endpoint declares it, and a DB features table would drift).
create table public.roles (
    key           text primary key,
    display_name  text not null,
    description   text,
    -- 'admin' and 'free_user' only: undeletable, key/is_system immutable.
    is_system     boolean not null default false,
    -- Role assigned to a user with no profiles row (preserves 0014's
    -- decision not to insert a profiles row on signup).
    is_default    boolean not null default false,
    -- Small colored pill shown next to a user's role on their profile
    -- (frontend/src/app/settings/page.tsx) and in the admin roles list.
    badge_color   text not null default '#64748b',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create unique index roles_single_default_idx on public.roles (is_default) where is_default;

create table public.role_features (
    role_key    text not null references public.roles (key) on delete cascade on update cascade,
    feature_key text not null,
    primary key (role_key, feature_key)
);

insert into public.roles (key, display_name, description, is_system, is_default, badge_color) values
    ('admin', 'Admin', 'Full access, including managing roles and permissions.', true, false, '#7c3aed'),
    ('free_user', 'Free', 'Default role for new signups.', true, true, '#64748b'),
    ('paid_user', 'Paid', 'Full creator access.', false, false, '#f59e0b');

-- Default grants -- see backend/src/permissions/features.py for the
-- registry these keys come from. admin/paid_user get everything (paid_user
-- minus admin_manage_roles); free_user is withheld render/tts/avatar/admin,
-- matching the brief this migration was written for exactly.
insert into public.role_features (role_key, feature_key)
select 'admin', feature_key from (values
    ('render_generate'), ('tts_synthesize'), ('avatar_generate'),
    ('assets_manage'), ('stock_media_use'), ('projects_manage'),
    ('niches_use'), ('admin_manage_roles')
) as f (feature_key)
union all
select 'paid_user', feature_key from (values
    ('render_generate'), ('tts_synthesize'), ('avatar_generate'),
    ('assets_manage'), ('stock_media_use'), ('projects_manage'),
    ('niches_use')
) as f (feature_key)
union all
select 'free_user', feature_key from (values
    ('assets_manage'), ('stock_media_use'), ('projects_manage'), ('niches_use')
) as f (feature_key);

update public.profiles set role = 'free_user' where role = 'user';
alter table public.profiles alter column role drop default;
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles alter column role set default 'free_user';
alter table public.profiles add constraint profiles_role_fkey
    foreign key (role) references public.roles (key) on update cascade on delete restrict;

alter table public.roles enable row level security;
alter table public.role_features enable row level security;
-- No policies at all, same "manual/service-role only" precedent as 0008 and
-- 0014 -- every read and write goes through the backend's service-role
-- client (backend/src/permissions/repository.py), never straight from the
-- frontend.
