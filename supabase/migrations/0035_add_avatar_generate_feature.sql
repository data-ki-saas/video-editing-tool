insert into public.role_features (role_key, feature_key)
values ('admin', 'avatar_generate'), ('paid_user', 'avatar_generate')
on conflict do nothing;
