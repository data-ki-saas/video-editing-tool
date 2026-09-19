-- Caches the fal.ai cartoonify output (avatar_gen/service.py's
-- `_cartoonify_and_crop`) that used to be discarded once the atlas was
-- baked -- NULL for avatars generated via the free parametric-drawing path
-- (build_atlas_png), which has no such source image, and for rows created
-- before this migration. Lets avatar_gen/service.py's rebake_generated_avatar
-- re-run build_atlas_png_from_photo against the SAME cartoonify output when
-- a baking bug gets fixed, instead of re-calling fal.ai (real vendor cost)
-- and forcing the user to re-upload their photo and lose their atlas_key/
-- design_id.
alter table public.avatar_designs
    add column if not exists source_cartoon_key text;
