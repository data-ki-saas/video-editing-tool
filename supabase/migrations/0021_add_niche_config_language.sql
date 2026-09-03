-- Lets the same niche name (e.g. "Real Estate") be cached once per script
-- language -- the LLM-generated script_template/hooks/cta_template differ
-- by language (see backend/src/niches/service.py), so niche_key alone can
-- no longer be the uniqueness boundary.
alter table public.niche_configs add column if not exists language text not null default 'en';

alter table public.niche_configs drop constraint if exists niche_configs_niche_key_key;
drop index if exists public.niche_configs_niche_key_idx;
alter table public.niche_configs add constraint niche_configs_niche_key_language_key unique (niche_key, language);
