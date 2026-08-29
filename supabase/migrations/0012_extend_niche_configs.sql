-- Extends the niche-config catalog (0008_create_niche_configs.sql) beyond a
-- flat field list so a niche's LLM-generated config can drive a guided,
-- generic creation wizard instead of just a form: which photo/video slots
-- to ask for (with semantic hints, e.g. "hero shot" vs "amenity"), a
-- dropdown of pre-written opening hooks, an end-screen CTA template, and
-- hashtag stems for auto-generated social copy. All additive/nullable-or-
-- defaulted so every existing cached niche_configs row stays valid as-is.
alter table public.niche_configs
    -- Array of {key, label, hint, kind: "image"|"video"|"either", required} --
    -- ordered upload slots for the wizard's media step. Semantic (per-niche)
    -- but content-free, same reasoning as `fields`: never becomes real
    -- columns on `projects`.
    add column if not exists media_slots jsonb not null default '[]'::jsonb,
    -- Pre-written opening lines for the wizard's hook picker, with {field_key}
    -- placeholders resolved the same way script_template's are.
    add column if not exists hooks jsonb not null default '[]'::jsonb,
    -- e.g. "Comment '{keyword}' below for the full {noun}" -- the wizard
    -- substitutes {keyword} with a user-entered word and drops {noun} if unset.
    add column if not exists cta_template text,
    -- Niche-level hashtag stems (e.g. ["RealEstate","Homes"]) combined at
    -- generation time with location/attribute values for social copy.
    add column if not exists hashtag_seed jsonb not null default '[]'::jsonb;
