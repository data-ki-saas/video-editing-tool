# Timeline editor

A Reel-format (9:16) video timeline editor. Split into a `backend/` (FastAPI)
and `frontend/` (Next.js) app, following the same structure as the sibling
`data` project.

- **frontend/** — Next.js App Router UI. Renders the timeline editor
  (`@creatomate/preview`) and talks to the backend over HTTP.
- **backend/** — FastAPI service. Owns Supabase (via the service-role key)
  and Cloudflare R2, so no storage credential ever reaches the browser.
- **supabase/migrations/** — shared schema (`users`, `projects`, `assets`),
  applied directly to the Supabase project both apps point at.

## Hosting

| Piece                | Host       |
| --------------------- | ---------- |
| frontend               | Vercel     |
| backend                | Render     |
| Postgres + Auth        | Supabase   |
| media storage (assets) | Cloudflare R2 |

`render.yaml` at the repo root defines the backend's Render service
(`rootDir: backend`). The frontend deploys to Vercel with its project root
set to `frontend/`.

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
