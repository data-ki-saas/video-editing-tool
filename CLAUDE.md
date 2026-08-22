This repo is split into `backend/` (FastAPI), `frontend/` (Next.js), and
`worker/` (Node), same layout philosophy as the sibling `../data` project —
when in doubt about a pattern (backend module layering, portal auth
structure, LLM provider abstraction, DEPLOY.md shape), check how `../data`
already solved it before inventing something new. See root
[README.md](README.md) for the architecture/hosting diagram and
[DEPLOY.md](DEPLOY.md) for env vars and deploy steps.

`frontend/` has its own `frontend/CLAUDE.md` / `frontend/AGENTS.md` — read
those before touching frontend code, since this Next.js version has breaking
changes from what most training data assumes.

## What this product is

A short-form video "reel" generator. Originally scoped to real-estate
listing videos, then deliberately generalized: any business niche (real
estate, hospitality, auto, garments, gifts, hardware, ...) is supported via
an LLM-driven niche-configuration module rather than hardcoded per-vertical
fields. `projects.niche` (text) + `projects.attributes` (jsonb) hold
whatever fields matter for that niche — never add real-estate-specific
columns to `projects` again; that was tried once and reverted.

**Driving vision**: the primary user is an influencer/creator turning raw
mobile-phone or GoPro footage into a finished reel for YouTube/Instagram —
not a professional video editor. This should shape every editor UI/UX
decision: favor simple, direct-manipulation controls (drag the clip
rectangle, drag a colored handle, drag a dot on the timeline) over
menus/dialogs/technical jargon, and favor sensible smart defaults (e.g. a
zoom/pan easing back to normal automatically) over exposing every knob.
When a feature could go either the "pro NLE" way or the "intuitive for a
casual creator" way, default to the latter.

## Conventions specific to this repo

- **Secrets default to `backend/`**, not `frontend/`. The two exceptions —
  `frontend/src/app/api/render/route.ts` (Creatomate API key) and
  `.../api/webhooks/creatomate/route.ts` (Supabase service-role key) — exist
  for specific, documented reasons (see their own file comments), not as a
  precedent to hold more secrets in Next.js routes by default.
- **R2 has two buckets on purpose**: a private uploads bucket (presigned
  URLs only, `R2_SIGNED_URL_EXPIRES_SECONDS`) and a public finished-renders
  bucket (Cloudflare custom domain, fed by `worker/`). Never make the
  uploads bucket public; never persist a resolved presigned URL into
  `projects.timeline` (it expires — see `lib/timeline/resolve.ts`'s
  `_appMeta[id].assetId` pattern instead).
- **LLM provider is configurable, DeepSeek by default** (not Anthropic,
  unlike `../data`'s default) — mirrors `../data/backend/src/llm/`'s
  `LLMProvider` abstraction and `LLM_PROVIDER` env var switch.
- **No billing/metering during the POC phase** — but abuse-rate-limiting
  (a `usage_events` table, fixed daily caps) is in scope and expected; don't
  conflate the two when a feature request mentions "limits."

## Current status

A detailed, phased implementation plan lives at
`C:\Users\me\.claude\plans\atomic-foraging-shannon.md` — check its phase
list before assuming what's built vs. still planned; this file intentionally
doesn't duplicate that level of detail since it goes stale fast.
