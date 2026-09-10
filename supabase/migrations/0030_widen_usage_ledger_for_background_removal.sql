-- usage_ledger (0016) predates the background-removal feature (0019) and
-- was never widened for it -- matting/service.py's own record_event calls
-- write event_type='background_removal' (both the video/VEED and photo/
-- rembg paths) and unit='images' (the photo path only, quantity=1 per
-- image; the video path already used the existing 'seconds' unit), both of
-- which the check constraints below rejected outright.
alter table public.usage_ledger drop constraint usage_ledger_event_type_check;
alter table public.usage_ledger add constraint usage_ledger_event_type_check
    check (event_type in ('render', 'voiceover', 'avatar_video', 'llm_completion', 'background_removal'));

alter table public.usage_ledger drop constraint usage_ledger_unit_check;
alter table public.usage_ledger add constraint usage_ledger_unit_check
    check (unit in ('seconds', 'tokens', 'images'));
