-- Exempts admin/paid_user from recordings/service.py's FREE_RECORDINGS_LIMIT
-- (15 saved recordings for a free account) -- same "new boolean feature key,
-- seed-grant it to admin + paid_user" shape as 0025's social_posting
-- feature. free_user (and any other role an admin creates without
-- explicitly granting this) stays capped by default-deny, same as every
-- other feature flag in this app.
insert into public.role_features (role_key, feature_key)
values ('admin', 'recordings_unlimited'), ('paid_user', 'recordings_unlimited')
on conflict do nothing;
