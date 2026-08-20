-- Every user was previously limited to exactly one project ("My Project"),
-- created lazily by getOrCreateDefaultProject(). A user makes one reel per
-- listing/item, not one ever. `niche` + `attributes` are deliberately
-- generic (not real-estate-specific columns) -- what fields matter for a
-- "listing" varies entirely by business (real estate wants address/price/
-- beds/baths, an auto dealer wants make/model/mileage, a garment shop wants
-- size/material). See the niche_configs table (migration 0008) for how the
-- actual field set per niche is determined.
alter table public.projects
    add column if not exists niche text,
    add column if not exists attributes jsonb not null default '{}'::jsonb;

-- The original {"tracks":[]} default was never implemented against by any
-- code path -- VideoEditor.tsx builds its own Creatomate-shaped template in
-- memory and never persists it. This becomes the real, persisted shape:
-- the same JSON sent to both Preview.setSource() and POST /api/render.
alter table public.projects
    alter column timeline set default
        '{"output_format":"mp4","width":1080,"height":1920,"elements":[],"_appMeta":{}}'::jsonb;

update public.projects
set timeline = '{"output_format":"mp4","width":1080,"height":1920,"elements":[],"_appMeta":{}}'::jsonb
where timeline = '{"tracks":[]}'::jsonb;
