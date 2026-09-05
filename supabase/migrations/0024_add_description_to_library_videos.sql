-- A short, user-editable blurb shown under the reel's name on the /library
-- page (see library/page.tsx's in-place name/description editing) -- kept
-- separate from project_name (an immutable snapshot taken at save time,
-- see 0023's own comment) since this is deliberately editable afterward.
alter table public.library_videos
    add column if not exists description text
    constraint library_videos_description_length check (char_length(description) <= 120);
