-- Voiceover audio (ElevenLabs TTS output, mp3) becomes a normal per-project
-- asset -- same presigned-URL/ownership/RLS treatment as an uploaded video
-- or image, reusing backend/src/assets unchanged rather than a side channel.
-- Curated background music is deliberately NOT added here: it's shared,
-- unowned content, not per-project, so it doesn't belong in this table
-- (see supabase/migrations for the music-library approach instead).
alter table public.assets drop constraint if exists assets_kind_check;
alter table public.assets add constraint assets_kind_check
    check (kind in ('video', 'image', 'audio'));

alter table public.assets drop constraint if exists assets_mime_type_check;
alter table public.assets add constraint assets_mime_type_check
    check (mime_type in ('video/mp4', 'image/jpeg', 'image/png', 'audio/mpeg'));
