# Reel Creator

A Reel-format (9:16) video reel maker. Split into a `backend/` (FastAPI)
and `frontend/` (Next.js) app, following the same structure as the sibling
`data` project.

- **frontend/** — Next.js App Router UI. Hosts the timeline editor and the
  free in-browser export (see "Rendering" below).
- **backend/** — FastAPI service. Owns Supabase (via the service-role key)
  and the private uploads R2 bucket, so no upload storage credential ever
  reaches the browser.
- **supabase/migrations/** — shared schema (`users`, `projects`, `assets`,
  `niche_configs`, `usage_events`), applied directly to the Supabase project
  every app points at.

This is a niche-generic reel generator, not a real-estate-specific tool —
`projects.niche` + `projects.attributes` (freeform jsonb) hold whatever
fields matter for whichever business created that reel; see "Niches" below.

## Hosting

| Piece                        | Host       |
| ----------------------------- | ---------- |
| frontend                      | Vercel     |
| backend                       | Render     |
| Postgres + Auth                | Supabase   |
| upload storage (private)       | Cloudflare R2 |
| cover thumbnails (public, CDN) | Cloudflare R2 + custom domain |

`render.yaml` at the repo root defines the backend's Render service
(`rootDir: backend`). The frontend deploys to
Vercel with its project root set to `frontend/`.

## Setup

1. Create a Supabase project and run the migrations in `supabase/migrations/`
   in order.
2. Create an R2 bucket and an R2 API token with object read/write access.
   Leave the bucket **private** — no public access, no r2.dev subdomain, no
   custom domain. The backend is the only thing with credentials, and it
   hands the browser a short-lived presigned URL per asset instead of a
   permanent public link (see "Asset URLs" below).
3. Backend: copy `backend/.env.example` to `backend/.env`, fill in the
   Supabase (service role) and R2 values, then `cd backend && uv sync && uv run uvicorn src.main:app --reload`.
4. Frontend: copy `frontend/.env.local.example` to `frontend/.env.local`,
   fill in the Supabase (anon key) and API base URL values,
   then `cd frontend && npm install && npm run dev`.

The database trigger creates a `public.users` row whenever Supabase Auth creates a
user. Existing Auth users can be synchronized once with:

```sql
insert into public.users (id, email)
select id, email from auth.users
on conflict (id) do nothing;
```

## Asset API

`POST /api/assets?project_id=<id>` (backend, port 8000) accepts a multipart
form request with a `file` field and an `Authorization: Bearer <supabase access token>`
header. Files must be `.mp4`, `.jpg`, or `.png` and are limited to 500 MB.

```bash
curl -X POST "http://localhost:8000/api/assets?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -F "file=@./clip.mp4;type=video/mp4"
```

The route verifies the token, checks the caller owns `project_id`, uploads to
`projects/<project-id>/` in R2, and inserts the corresponding `assets` row
using the service-role Supabase client. If the metadata insert fails, the
uploaded R2 object is deleted.

## Asset URLs

Every `AssetInfo` the API returns (from upload, or `GET /api/assets`) includes
a `url` field. That's a **presigned R2 URL**, valid for
`R2_SIGNED_URL_EXPIRES_SECONDS` (default 1 hour) — not a permanent link. The
R2 bucket itself is private, so this is the only way a browser ever reads an
object, and every presign is preceded by the same project-ownership check as
everything else in this API. Don't cache a `url` past its expiry; re-fetch the
asset instead.

## Niches (LLM-driven, generic forms)

`GET/POST /api/niches` (backend). A "New Reel" is always for some business
niche (real estate, hospitality, auto, garments, gifts, hardware, or
literally anything a user types) — rather than hardcoding fields per
vertical, the first time a niche name is used, the backend asks its
configured LLM provider (`backend/src/llm/`, DeepSeek by default,
Anthropic as an alternative, switched via `LLM_PROVIDER`) to design a short
field schema (3-6 fields) and a voiceover script template for it, then
caches the result in `niche_configs` (shared across every user — the field
schema for "auto dealership" isn't personal, and sharing avoids a redundant
LLM call the next time someone picks the same niche). Every call after the
first for that niche is an instant cache hit.

The generated fields are a UI scaffold for the "New Reel" form only —
`projects.attributes` stays a freeform jsonb column regardless, never an
enforced schema. If niche generation ever returns something malformed, the
whole request fails with a 502 rather than silently caching a broken form.

## Rendering

The only render path is the free, local in-browser export (Mediabunny /
WebCodecs, `frontend/src/lib/localRender/`) — the finished video is produced
on the user's own device, so there is no server-side render service.

The public renders bucket (a second, separate R2 bucket with a Cloudflare
custom domain, `R2_RENDERS_*` in the backend) holds public media: **cover thumbnails**, library assets and shared recordings
the backend writes (export is local, in the browser, so no finished renders land here).
Keep it separate from the private uploads bucket from "Asset URLs" above: a
Cloudflare custom domain makes an *entire* bucket publicly readable, and R2
doesn't offer prefix-scoped public access to split one bucket safely.

## Abuse guardrails (not billing)

Login-gating alone doesn't stop a signed-in user from running up
storage or third-party API costs. `usage_events` (one row per
voiceover/upload/etc.) backs plain fixed-daily-cap checks in the backend
(e.g. `MATTING_DAILY_CAP`, `AVATAR_GENERATE_DAILY_CAP`) — a 429 past the cap,
not a metering/billing system. No
plans or tiers exist; don't build them into a feature request unless
explicitly asked for.

## Sharing (schema only, not yet wired up)

`project_shares` (migration 0007) exists in the schema — a token, a
project reference, a `revoked_at` for revocation — but no route or UI
creates, lists, or serves a share link yet. Treat "share a reel" as a
planned feature, not a working one, until that lands.
