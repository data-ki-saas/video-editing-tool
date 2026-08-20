# Reel Creator

A Reel-format (9:16) video reel maker. Split into a `backend/` (FastAPI)
and `frontend/` (Next.js) app, following the same structure as the sibling
`data` project.

- **frontend/** — Next.js App Router UI. Renders the timeline editor
  (`@creatomate/preview`), triggers renders and receives Creatomate's webhook
  (both hold their own server-only secrets — see "Rendering pipeline" below).
- **backend/** — FastAPI service. Owns Supabase (via the service-role key)
  and the private uploads R2 bucket, so no upload storage credential ever
  reaches the browser.
- **worker/** — a small standalone Node service that mirrors a finished
  Creatomate render into a *second*, publicly-served R2 bucket, so playback
  comes from our own Cloudflare-fronted domain instead of Creatomate's
  temporary hosted URL. See "Delivering finished videos" below.
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
| render-transfer-worker        | Render     |
| Postgres + Auth                | Supabase   |
| upload storage (private)       | Cloudflare R2 |
| finished-render storage (public, CDN) | Cloudflare R2 + custom domain |

`render.yaml` at the repo root defines the backend's and worker's Render
services (`rootDir: backend` / `rootDir: worker`). The frontend deploys to
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
   fill in the Supabase (anon key), API base URL, and Creatomate values,
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

## Rendering pipeline

```
browser --(final timeline JSON)--> POST /api/render (frontend, Vercel)
                                        |
                                        v
                                Creatomate.startRender()  -- fire-and-forget,
                                        |                    not the polling
                                        |                    render() call
                                        v
                          projects.render_id / render_status = 'planned' saved
                                        |
                       ... Creatomate renders the video, minutes later ...
                                        |
                                        v
        POST /api/webhooks/creatomate (frontend, Vercel) <-- Creatomate calls back
                                        |
                        projects.render_status = 'succeeded'
                        projects.render_url = Creatomate's temporary URL
                                        |
                                        v
                POST /transfer (render-transfer-worker, Render) -- fire-and-forget
                                        |
              downloads the MP4 from Creatomate, streams it into R2,
              then sets render_status = 'completed', render_url = our own
              Cloudflare-fronted URL
```

Two Next.js routes hold their own secrets rather than delegating to the
FastAPI backend, a deliberate exception to "backend owns all secrets"
elsewhere in this repo:

- **`POST /api/render`** ([frontend/src/app/api/render/route.ts](frontend/src/app/api/render/route.ts)) —
  authenticates via the cookie-based Supabase client, checks project
  ownership, calls `Creatomate.Client.startRender()` with `CREATOMATE_API_KEY`.
- **`POST /api/webhooks/creatomate`** ([frontend/src/app/api/webhooks/creatomate/route.ts](frontend/src/app/api/webhooks/creatomate/route.ts)) —
  receives Creatomate's completion callback. This has no user session to
  authenticate with (Creatomate is calling us, not the browser), so it uses
  the Supabase **service-role** key instead — duplicated from `backend/`'s
  copy, an accepted tradeoff of keeping this receiver here instead of in
  FastAPI. **Security note:** Creatomate does not publish an HMAC-signature
  scheme for webhooks (checked their Node SDK source and public docs — there
  isn't one). Instead, `webhook_url` carries a `secret` query param we
  generate ourselves (`CREATOMATE_WEBHOOK_SECRET`) and the receiver checks
  with a timing-safe comparison. Treat that secret like an API key, and
  rotate it if the URL is ever exposed somewhere it shouldn't be (logs,
  error trackers, etc).

`projects.render_status` moves through Creatomate's own states
(`planned`/`waiting`/`rendering`/`succeeded`/`failed`) and then, only once the
`worker/` transfer finishes, our own app-level `completed` — deliberately not
the same thing as Creatomate's `succeeded`, since `succeeded` only means
Creatomate finished rendering, not that the video lives anywhere we control
yet.

## Delivering finished videos

Creatomate's hosted render URL isn't meant as permanent storage or a
CDN you control — it's why the pipeline above always mirrors a finished
render into R2 before calling it `completed`. Recommended DNS/bucket setup
for that:

1. **Use a second, separate R2 bucket for finished renders** — do not reuse
   the private uploads bucket from "Asset URLs" above. A Cloudflare custom
   domain makes an *entire* bucket publicly readable; finished renders are
   meant to be shared/played back publicly, raw user uploads are not, and
   R2 doesn't offer prefix-scoped public access to split one bucket safely.
2. In Cloudflare: **R2 → your renders bucket → Settings → Public access →
   Custom Domains**, and connect a subdomain, e.g. `videos.yourapp.com`.
   Cloudflare adds the DNS record for you (a proxied `CNAME`, orange-clouded)
   — you don't hand-write one. Once connected, every object in that bucket is
   served from Cloudflare's edge under your own domain, cached globally, with
   **zero egress fees** (R2 has no egress charge, and Cloudflare-to-Cloudflare
   traffic never leaves their network).
3. Scope the R2 API token the worker uses to *only* that bucket — it never
   needs to touch the private uploads bucket, and vice versa.
4. Point `R2_RENDERS_PUBLIC_URL` (worker/.env) at that custom domain. That's
   the value stored in `projects.render_url` once a transfer finishes.

**Why a separate worker service instead of doing the transfer inline in the
webhook** (`worker/src/server.js`, a small standalone Node HTTP service,
deployed as its own Render service via `render.yaml`'s `render-transfer-worker`):
a finished render can be a multi-hundred-MB video. Streaming that from
Creatomate's URL into R2 inside a Vercel serverless function risks hitting
its execution-time and payload limits — Vercel functions are built for quick
request/response cycles, not minutes-long file transfers. Render's worker
runs as a long-lived process with no such ceiling, so the webhook route just
fires a small JSON request at it (`{projectId, renderId, sourceUrl}`) and
returns immediately; the worker does the actual streaming download → streaming
multipart upload → final DB write on its own time.

**Known limitation of this "basic" version, worth upgrading before this
carries real traffic:** the worker acknowledges the transfer request before
the transfer finishes, with no retry and no durable queue — a crash or
redeploy mid-transfer loses that job silently (Creatomate's webhook itself
won't refire once already acknowledged). A production version should push
`{projectId, renderId, sourceUrl}` onto a durable queue (even a `pending_transfers`
Postgres table polled by the worker would do) instead of a single in-memory
HTTP request, so an interrupted transfer can be retried.

## Abuse guardrails (not billing)

Login-gating alone doesn't stop a signed-in user from running up render or
storage costs. `usage_events` (one row per render/voiceover/upload) backs a
plain fixed-daily-cap check in `app/api/render/route.ts` (`RENDER_DAILY_LIMIT`,
currently 10/day) — a 429 past the cap, not a metering/billing system. No
plans or tiers exist; don't build them into a feature request unless
explicitly asked for.

## Sharing (schema only, not yet wired up)

`project_shares` (migration 0007) exists in the schema — a token, a
project reference, a `revoked_at` for revocation — but no route or UI
creates, lists, or serves a share link yet. Treat "share a reel" as a
planned feature, not a working one, until that lands.
