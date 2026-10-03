-- Every newly registered user gets a "Starter Reel" already in their account,
-- cloned from one admin-designated template project (initially the admin's
-- "New Reel"), so they land in a populated editor instead of an empty wizard.
--
-- Which project is the template lives in a one-row table, NOT a boolean on
-- `projects`: projects are user-updatable under RLS, so a flag there would let
-- any user nominate their own project to be copied into every future signup.
-- This table has no policies, so only the service role / SQL editor can write it.
create table if not exists public.starter_project (
    singleton boolean primary key default true check (singleton),
    project_id uuid references public.projects (id) on delete set null
);

alter table public.starter_project enable row level security;

-- Seed with the most recently edited "New Reel" owned by an admin. Re-point it
-- any time with:
--   update public.starter_project set project_id = '<project uuid>';
insert into public.starter_project (singleton, project_id)
select true, p.id
from public.projects p
join public.profiles pr on pr.user_id = p.owner_id and pr.role = 'admin'
where p.name = 'New Reel'
order by p.updated_at desc
limit 1
on conflict (singleton) do nothing;

-- Asset rows are cloned pointing at the SAME R2 object (storage_key) -- no file
-- copy. That's already supported: backend/src/assets/service.py's delete_asset
-- reference-counts by storage_key before deleting the object (see 0009/0020).
-- The timeline refers to assets by id (e.g. _appMeta[...].assetId, sequence
-- entries, tts/music clips), so every old asset id is swapped for its new one
-- across the whole timeline JSON. The cover thumbnail is deliberately not
-- copied: deleting/replacing a cover removes its public R2 object, which would
-- break the template's own cover.
create or replace function public.clone_starter_project_for_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
    v_src public.projects%rowtype;
    v_new_project_id uuid;
    v_timeline text;
    v_asset record;
    v_new_asset_id uuid;
begin
    select p.* into v_src
    from public.starter_project s
    join public.projects p on p.id = s.project_id;

    if not found then
        return new;
    end if;

    v_timeline := v_src.timeline::text;
    v_new_project_id := gen_random_uuid();

    insert into public.projects (id, owner_id, name, niche, attributes)
    values (v_new_project_id, new.id, 'Starter Reel', v_src.niche, v_src.attributes);

    for v_asset in select * from public.assets where project_id = v_src.id loop
        v_new_asset_id := gen_random_uuid();
        insert into public.assets
            (id, project_id, uploaded_by, filename, kind, mime_type, size_bytes, storage_key, content_hash)
        values
            (v_new_asset_id, v_new_project_id, new.id, v_asset.filename, v_asset.kind, v_asset.mime_type,
             v_asset.size_bytes, v_asset.storage_key, v_asset.content_hash);
        v_timeline := replace(v_timeline, v_asset.id::text, v_new_asset_id::text);
    end loop;

    update public.projects set timeline = v_timeline::jsonb where id = v_new_project_id;

    return new;
exception when others then
    -- Never block signup over a starter copy; the user just starts empty.
    -- (The block's inserts are rolled back with the exception.)
    raise warning 'clone_starter_project_for_new_user failed for %: %', new.id, sqlerrm;
    return new;
end;
$$;

-- On public.users (inserted by handle_new_user from the auth.users trigger,
-- see 0001) rather than extending handle_new_user itself.
drop trigger if exists on_public_user_created_clone_starter on public.users;
create trigger on_public_user_created_clone_starter
    after insert on public.users
    for each row execute procedure public.clone_starter_project_for_new_user();
