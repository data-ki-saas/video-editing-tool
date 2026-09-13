-- Gates the Phase 4 avatar-direction endpoint (backend/src/avatar/) --
-- same "new boolean feature key, seed-grant it to admin + paid_user" shape
-- as 0025's social_posting / 0027's recordings_unlimited. Withheld from
-- free_user by default-deny, same tier as every other LLM-metered feature
-- (tts_synthesize, the retired avatar_generate).
insert into public.role_features (role_key, feature_key)
values ('admin', 'avatar_direct'), ('paid_user', 'avatar_direct')
on conflict do nothing;
