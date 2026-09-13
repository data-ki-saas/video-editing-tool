-- Gates the Phase 7 avatar-edit endpoint (backend/src/avatar/, POST
-- /api/avatar/edit) -- same "new boolean feature key, seed-grant it to
-- admin + paid_user" shape as 0033's avatar_direct / 0035's avatar_generate.
insert into public.role_features (role_key, feature_key)
values ('admin', 'avatar_edit'), ('paid_user', 'avatar_edit')
on conflict do nothing;
