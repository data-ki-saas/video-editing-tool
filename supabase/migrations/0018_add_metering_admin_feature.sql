-- feature_key is validated against backend/src/permissions/features.py's
-- registry, not an FK -- see 0015's own comment on that choice.
insert into public.role_features (role_key, feature_key)
values ('admin', 'metering_admin_view')
on conflict do nothing;
