# Deployment Guide

This app is split across five deployed pieces, deliberately (see `README.md`
for the full architecture diagram and the reasoning behind each split):

| Platform | What lives there | Why not somewhere else |
|---|---|---|
| **Vercel** | `frontend/` (Next.js, App Router) | Standard Next.js host. Also holds the render-trigger and Creatomate-webhook routes — see `README.md`'s "Rendering pipeline". |
| **Render** | `backend/` (FastAPI) | Owns Supabase's service-role key and the private uploads R2 bucket — no storage credential ever reaches the browser. |
| **Render** | `worker/` (Node) | Streams a finished render from Creatomate into R2. Runs as a long-lived process on purpose — see "Why a separate worker service" in `README.md`; a Vercel serverless function isn't built for a multi-hundred-MB streamed transfer. |
| **Supabase** | Postgres (`users`, `projects`, `assets`) + Auth | Only hosts Postgres/Auth — can't run either backend/worker itself. |
| **Cloudflare R2** | Two buckets: private uploads, public finished-renders | S3-compatible object storage. Kept as two buckets because a Cloudflare custom domain makes an *entire* bucket publicly readable, and only one of these should be public. |
| **Creatomate** | Video rendering (external SaaS, not deployed by you) | Not self-hosted — you only need an account + API key. |

Deploy in this order — each later step needs credentials or a URL from an
earlier one.

---

## 0. Prerequisites

- [ ] Supabase account + a new project created
- [ ] Cloudflare account with R2 enabled
- [ ] Render account, connected to this repo
- [ ] Vercel account, connected to this repo
- [ ] A Creatomate account + API key (Settings > API Keys) and a project
      public token (Settings > Preview SDK, or your project's dashboard)

---

## 1. Supabase (database + auth)

1. Create a new Supabase project.
2. Apply every migration in `supabase/migrations/` **in order**, via the SQL
   Editor or `supabase db push`:
   - `0001_create_media_schema.sql` — `users`/`projects`/`assets` tables,
     the `handle_new_user` trigger, and RLS policies.
   - `0002_drop_assets_public_url.sql` — drops `assets.public_url` (reads
     went from a permanent public link to a backend-generated presigned URL).
   - `0003_add_render_tracking_to_projects.sql` — adds `render_id`,
     `render_status`, `render_url` to `projects`.
3. **Auth settings** (Authentication > Providers > Email): if you leave
   "Confirm email" ON (the default) and haven't configured SMTP, sign-up
   will silently require a confirmation email that never arrives — either
   turn it off, or set up SMTP and complete step 3a below (required either
   way if you leave it on).
3a. **Auth URL Configuration** (Authentication > URL Configuration) — only
   needed if "Confirm email" is ON:
   - **Site URL**: your production frontend URL (e.g.
     `https://your-app.vercel.app`). This is the fallback base Supabase uses
     for any auth email if the request didn't specify one — leaving it as
     the default `http://localhost:3000` sends every confirmation link (in
     every environment) to localhost, broken for anyone but you in local dev.
   - **Redirect URLs**: add both `https://your-app.vercel.app/**` and
     `http://localhost:3000/**` (or whatever ports/domains you actually use).
     `signup/page.tsx` explicitly passes `emailRedirectTo` per-request (so it
     matches wherever signup actually happened, not just "Site URL"), but
     Supabase only honors that target if it matches an entry in this
     allow-list — otherwise it silently falls back to Site URL.
4. Collect from **Project Settings > API**. Supabase now shows two key
   formats depending on when your project was created — use whichever pair
   your project has, they're equivalent:

   | Value | Legacy label | Newer label | Placeholder used below |
   |---|---|---|---|
   | Project URL | Project URL | Project URL | `<SUPABASE_URL>` |
   | Public key | `anon` `public` (a JWT) | **Publishable key** (`sb_publishable_...`) | `<SUPABASE_ANON_KEY>` |
   | Secret key (⚠️ never ship to the browser) | `service_role` (a JWT) | **Secret key** (`sb_secret_...`) | `<SUPABASE_SERVICE_ROLE_KEY>` |

   Getting these swapped is a real, easy-to-hit mistake, not hypothetical:
   pasting the secret key into `NEXT_PUBLIC_SUPABASE_ANON_KEY` produces
   `Forbidden use of secret API key in browser` at runtime — the JS SDK
   detects a secret-key prefix and refuses to run it client-side. If you see
   that error, re-check this exact value.

   `SUPABASE_SERVICE_ROLE_KEY` is used in **three** places in this app
   (backend, worker, and the frontend's webhook route) — the same value in
   all three, not three different keys.

### 1a. Auto-deploying migrations on push (recommended, do this once)

Connect this repo to Supabase so anything added to `supabase/migrations/`
deploys automatically on push to `main`, instead of re-running step 2 by hand
every time:

1. **Project Settings > Integrations > GitHub Integration > Authorize GitHub**.
2. Select this repo.
3. Set **Working directory** to `.` (repo root — where `supabase/` lives).
4. Set the **production branch** to `main`, enable **Deploy to production**,
   then **Enable integration**.

Verify it worked by checking **Database > Migrations** in the dashboard after
the next push that touches `supabase/migrations/`.

---

## 2. Cloudflare R2 (file storage — two buckets)

### 2a. Uploads bucket (private)

1. Create a bucket, e.g. `<R2_BUCKET_NAME>`.
2. Leave it **private** — do not enable public access, an r2.dev subdomain,
   or a custom domain. The backend is the only thing with credentials, and
   every read goes through a short-lived presigned URL it generates
   (see `README.md`'s "Asset URLs").
3. **R2 > Manage API Tokens > Create API Token** — read + write, scoped to
   *only* this bucket.
4. Collect:

   | Value | Placeholder used below |
   |---|---|
   | Account ID (right sidebar of the R2 dashboard) | `<R2_ACCOUNT_ID>` |
   | Access Key ID | `<R2_ACCESS_KEY_ID>` |
   | Secret Access Key (shown once — save it immediately) | `<R2_SECRET_ACCESS_KEY>` |
   | Bucket name | `<R2_BUCKET_NAME>` |

### 2b. Finished-renders bucket (public, CDN-fronted)

1. Create a **second, separate** bucket, e.g. `<R2_RENDERS_BUCKET_NAME>`.
2. **This bucket > Settings > Public access > Custom Domains** — connect a
   subdomain, e.g. `videos.yourapp.com`. Cloudflare provisions the DNS record
   for you (a proxied `CNAME`) — you don't hand-write one in the Cloudflare
   DNS tab yourself. This is what makes delivery global/cached with zero
   egress fees.
3. **Create a separate API token** scoped to *only* this bucket — do not
   reuse the uploads bucket's token. The worker never needs to touch the
   uploads bucket, and vice versa.
4. Collect:

   | Value | Placeholder used below |
   |---|---|
   | Access Key ID | `<R2_RENDERS_ACCESS_KEY_ID>` |
   | Secret Access Key | `<R2_RENDERS_SECRET_ACCESS_KEY>` |
   | Bucket name | `<R2_RENDERS_BUCKET_NAME>` |
   | Custom domain, with scheme, no trailing slash | `<R2_RENDERS_PUBLIC_URL>` (e.g. `https://videos.yourapp.com`) |

   (`R2_ACCOUNT_ID` is shared — both buckets live under the same account.)

---

## 3. Creatomate

1. Create an account, then collect:

   | Value | Placeholder used below |
   |---|---|
   | Secret API key (Settings > API Keys) | `<CREATOMATE_API_KEY>` |
   | Project public token (for the browser-side Preview SDK) | `<CREATOMATE_PUBLIC_TOKEN>` |

2. Generate your **own** webhook secret — Creatomate has no signed-webhook
   mechanism (checked their SDK/docs; there isn't one), so this is a value
   *you* invent and embed in the webhook URL yourself:
   ```
   openssl rand -hex 32
   ```
   → `<CREATOMATE_WEBHOOK_SECRET>`. Nothing to configure on Creatomate's side
   for this — it's generated and checked entirely within this app.

---

## 4. Backend (Render)

1. **New > Blueprint**, connect this repo — Render auto-detects
   `render.yaml`'s `timeline-editor-backend` service (root dir `backend/`).
2. Fill in every variable below in the service's **Environment** tab:

   | Variable | Required | Value |
   |---|---|---|
   | `SUPABASE_URL` | ✅ | `<SUPABASE_URL>` |
   | `SUPABASE_SERVICE_ROLE_KEY` | ✅ | `<SUPABASE_SERVICE_ROLE_KEY>` |
   | `R2_ACCOUNT_ID` | ✅ | `<R2_ACCOUNT_ID>` |
   | `R2_ACCESS_KEY_ID` | ✅ | `<R2_ACCESS_KEY_ID>` |
   | `R2_SECRET_ACCESS_KEY` | ✅ | `<R2_SECRET_ACCESS_KEY>` |
   | `R2_BUCKET_NAME` | ✅ | `<R2_BUCKET_NAME>` |
   | `CORS_ORIGINS` | ✅ | `<YOUR_VERCEL_URL>` (exact scheme, no trailing slash; comma-separate multiple origins) |
   | `MAX_UPLOAD_SIZE_MB` | optional | `500` |
   | `R2_SIGNED_URL_EXPIRES_SECONDS` | optional | `3600` |

   Do **not** set `R2_ENDPOINT_OVERRIDE` — it exists only for the test
   suite (pointing at a local moto server).
3. Deploy, then verify:
   ```
   curl https://<your-backend>.onrender.com/health
   # -> {"status": "ok"}
   ```
4. Check the deploy log for `CORS allow_origins=[...]` (logged once at
   startup) and confirm it shows your Vercel URL, not `[]`.

---

## 5. Render-transfer worker (Render)

1. In the same Blueprint (or a separate **New > Web Service**), Render
   detects `render.yaml`'s `render-transfer-worker` service (root dir
   `worker/`).
2. Fill in:

   | Variable | Required | Value |
   |---|---|---|
   | `WORKER_INTERNAL_SECRET` | ✅ | generate with `openssl rand -hex 32` — must match the frontend's `WORKER_INTERNAL_SECRET` exactly |
   | `R2_ACCOUNT_ID` | ✅ | `<R2_ACCOUNT_ID>` |
   | `R2_ACCESS_KEY_ID` | ✅ | `<R2_RENDERS_ACCESS_KEY_ID>` (the renders-bucket token, **not** the uploads one) |
   | `R2_SECRET_ACCESS_KEY` | ✅ | `<R2_RENDERS_SECRET_ACCESS_KEY>` |
   | `R2_RENDERS_BUCKET_NAME` | ✅ | `<R2_RENDERS_BUCKET_NAME>` |
   | `R2_RENDERS_PUBLIC_URL` | ✅ | `<R2_RENDERS_PUBLIC_URL>` |
   | `SUPABASE_URL` | ✅ | `<SUPABASE_URL>` |
   | `SUPABASE_SERVICE_ROLE_KEY` | ✅ | `<SUPABASE_SERVICE_ROLE_KEY>` |

3. Deploy, then verify:
   ```
   curl https://<your-worker>.onrender.com/health
   # -> ok
   ```
4. Note this service's URL — it's `RENDER_WORKER_URL` in the frontend's env
   vars (step 6).

---

## 6. Frontend (Vercel)

1. **Import project**, set **Root Directory** to `frontend`.
2. Framework preset: Next.js (auto-detected).
3. Set these **Project Settings > Environment Variables**:

   **Public (`NEXT_PUBLIC_*`, baked into the browser bundle at build time):**

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `<SUPABASE_URL>` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `<SUPABASE_ANON_KEY>` |
   | `NEXT_PUBLIC_API_BASE_URL` | `<YOUR_RENDER_BACKEND_URL>` (e.g. `https://timeline-editor-backend.onrender.com`, no trailing slash) |
   | `NEXT_PUBLIC_CREATOMATE_PUBLIC_TOKEN` | `<CREATOMATE_PUBLIC_TOKEN>` |

   **Secret (server-only — do NOT prefix with `NEXT_PUBLIC_`):**

   | Variable | Value |
   |---|---|
   | `CREATOMATE_API_KEY` | `<CREATOMATE_API_KEY>` |
   | `CREATOMATE_WEBHOOK_SECRET` | `<CREATOMATE_WEBHOOK_SECRET>` (from step 3) |
   | `SUPABASE_SERVICE_ROLE_KEY` | `<SUPABASE_SERVICE_ROLE_KEY>` |
   | `RENDER_WORKER_URL` | `<YOUR_RENDER_WORKER_URL>/transfer` (e.g. `https://render-transfer-worker.onrender.com/transfer`) |
   | `WORKER_INTERNAL_SECRET` | same value as the worker's `WORKER_INTERNAL_SECRET` (step 5) |
   | `SITE_URL` | see the pitfall below — set this once you know your production URL |

4. Deploy once first (without `SITE_URL`) to get your production URL
   assigned, then:
   - Set `SITE_URL` to that URL (or your custom domain, if you attach one) —
     exact scheme, no trailing slash.
   - Redeploy so `SITE_URL` takes effect (see pitfall #1 below).
5. Verify:
   - Load `/` — the marketing page with "Sign in"/"Sign up" links should
     render (styled, not raw unstyled text — if you see that, the build
     didn't pick up Tailwind, redeploy).
   - Sign up, land on `/dashboard`. Signing out and hitting `/dashboard`
     directly should redirect to `/login` (see `src/lib/supabase/middleware.ts`).
   - Upload a video from the dashboard, confirm it appears in the asset list.
   - Trigger a render, confirm `projects.render_status` moves from
     `planned` → `succeeded` → `completed` and `render_url` ends up pointing
     at your `R2_RENDERS_PUBLIC_URL` domain, not Creatomate's.

---

## 7. Post-deploy smoke test (all five pieces live)

- [ ] `GET /health` on the backend URL returns `{"status": "ok"}`
- [ ] `GET /health` on the worker URL returns `ok`
- [ ] Frontend loads; sign-up/login works; `/dashboard` redirects to `/login` when signed out
- [ ] Video upload succeeds end-to-end from the dashboard (frontend → backend → R2 uploads bucket + Supabase)
- [ ] `POST /api/render` returns 202 with a `renderId`
- [ ] Creatomate's dashboard shows the webhook delivery succeeded (check
      "Recent Deliveries" or similar under your project/webhook settings)
- [ ] `projects.render_status` reaches `completed` and `render_url` resolves
      to a playable video served from your Cloudflare custom domain

---

## Common pitfalls

1. **"Env var set but not applied."** Vercel bakes `NEXT_PUBLIC_*` vars into
   the JS bundle at *build* time; Render doesn't hot-reload env vars into a
   running instance. Both need a **fresh deploy after** changing a value —
   saving it in the dashboard alone does nothing until the next build/restart.
2. **`SITE_URL` left unset in production.** Without it, the render-trigger
   route falls back to Vercel's own `VERCEL_URL`, which isn't guaranteed
   stable across deployments. A render can take minutes; if a redeploy
   happens while one is in flight and `VERCEL_URL` shifted, the
   already-dispatched `webhook_url` may point at a stale deployment.
   Set `SITE_URL` explicitly to your production domain once you have one.
3. **`Forbidden use of secret API key in browser`.** `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   has the *secret* key's value in it instead of the anon/publishable one —
   see step 1.4's table. The Supabase JS SDK detects a secret-key prefix and
   refuses to run it client-side; this isn't a code bug, it's a swapped value.
4. **Confirmation email links to `localhost`.** Supabase's Auth "Site URL"
   is still the default `http://localhost:3000` — see step 3a. `signup/page.tsx`
   passes `emailRedirectTo` per-request, but Supabase still needs the actual
   URL listed in **Redirect URLs**, or it silently falls back to Site URL.
5. **CORS mismatch causing "Failed to fetch" on asset upload.** Backend's
   `CORS_ORIGINS` must exactly match the Vercel URL, scheme included, no
   trailing slash. Check the backend's startup log line
   (`CORS allow_origins=[...]`) to confirm what's actually configured.
6. **Webhook secret mismatch.** `CREATOMATE_WEBHOOK_SECRET` is generated by
   you, not Creatomate — if the webhook route returns 401 for every
   delivery, re-check it's the *exact* value embedded in the `webhook_url`
   the render-trigger route builds (it's a live query param, not something
   configured separately in Creatomate's dashboard).
7. **Public custom domain on the wrong bucket.** If asset URLs ever look
   like a permanent public link instead of a presigned URL with an
   `X-Amz-Signature` query string, the uploads bucket has public access
   enabled somewhere — it must stay private. Only the renders bucket (2b)
   should have a custom domain.
8. **`R2_ENDPOINT_OVERRIDE` set in a real environment.** Backend-only, test
   suite-only. If set in Render's dashboard, R2 access silently points at
   the wrong (or no) host.
9. **Cold starts on Render's free tier.** Both the backend and the worker
   spin down when idle — the first request after idle can take 30–60s.
   A render that finishes while the worker is asleep will still trigger it
   (the webhook route's `fetch()` wakes it), just with that extra delay
   before the transfer visibly starts.
10. **Worker transfer never happens.** Check three things in order: (a) the
   webhook route actually received the callback (its own logs), (b)
   `RENDER_WORKER_URL`/`WORKER_INTERNAL_SECRET` are set on the frontend and
   match the worker's `WORKER_INTERNAL_SECRET` exactly, (c) the worker's own
   logs for a `transfer failed` line — a bad R2 token for the renders
   bucket is the most common cause.

---

## Environment variable reference (complete)

Every row below says exactly where that value comes from — nothing here
should require guessing. "Self-generated" means you invent the value
yourself (a random secret); everything else comes from a specific dashboard.

### Backend (Render), from `backend/src/core/config.py`

| Variable | Default | Where to get it |
|---|---|---|
| `MAX_UPLOAD_SIZE_MB` | `500` | Not fetched — pick a number, optional to set |
| `CORS_ORIGINS` | `http://localhost:3000` | Your Vercel deployment URL (step 6) — Vercel project > **Settings > Domains**, or just the URL shown after your first deploy. Comma-separate if more than one. |
| `SUPABASE_URL` | `""` | Supabase project > **Settings > API > Project URL** |
| `SUPABASE_SERVICE_ROLE_KEY` | `""` | Supabase project > **Settings > API > Project API keys > `service_role`** (click "Reveal") |
| `R2_ACCOUNT_ID` | `""` | Cloudflare dashboard > **R2** — Account ID is in the right sidebar of the R2 overview page |
| `R2_ACCESS_KEY_ID` | `""` | Cloudflare > **R2 > Manage API Tokens > Create API Token** (scope: uploads bucket, step 2a) — shown after creating the token |
| `R2_SECRET_ACCESS_KEY` | `""` | Same token-creation screen as above — **shown once only**, copy it immediately |
| `R2_BUCKET_NAME` | `""` | The name you gave the uploads bucket when you created it (step 2a) |
| `R2_ENDPOINT_OVERRIDE` | `""` | **Don't set this** — tests only |
| `R2_SIGNED_URL_EXPIRES_SECONDS` | `3600` | Not fetched — pick a number, optional to set |

### Render-transfer worker (Render), from `worker/.env.example`

| Variable | Where to get it |
|---|---|
| `PORT` | Render sets this automatically — don't set it yourself |
| `WORKER_INTERNAL_SECRET` | Self-generated: run `openssl rand -hex 32`. Set the *same* value on the frontend (below) |
| `R2_ACCOUNT_ID` | Same value as the backend's `R2_ACCOUNT_ID` above (same Cloudflare account) |
| `R2_ACCESS_KEY_ID` | Cloudflare > **R2 > Manage API Tokens > Create API Token**, scoped to the *renders* bucket (step 2b) — a different token from the backend's |
| `R2_SECRET_ACCESS_KEY` | Same token-creation screen — shown once, copy immediately |
| `R2_RENDERS_BUCKET_NAME` | The name you gave the renders bucket when you created it (step 2b) |
| `R2_RENDERS_PUBLIC_URL` | The custom domain you connected under that bucket's **Settings > Public access > Custom Domains** (step 2b), e.g. `https://videos.yourapp.com` |
| `SUPABASE_URL` | Same value as the backend's `SUPABASE_URL` above |
| `SUPABASE_SERVICE_ROLE_KEY` | Same value as the backend's `SUPABASE_SERVICE_ROLE_KEY` above |

### Frontend (Vercel), from `frontend/.env.local.example`

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Same value as the backend's `SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project > **Settings > API > Project API keys > `anon` `public`** — **not** the `service_role` key |
| `NEXT_PUBLIC_API_BASE_URL` | The backend's Render URL — Render dashboard > `timeline-editor-backend` service > the URL shown at the top of its page, e.g. `https://timeline-editor-backend.onrender.com` |
| `NEXT_PUBLIC_CREATOMATE_PUBLIC_TOKEN` | Creatomate dashboard > your project > **Preview SDK** (or **Project Settings**) — the *public* token, not the API key |
| `CREATOMATE_API_KEY` | Creatomate dashboard > **Settings > API Keys** — the *secret* key |
| `SITE_URL` | This app's own production URL, once you know it — Vercel project page after first deploy, or your custom domain if you attach one. Leave unset for the very first deploy (see step 6) |
| `CREATOMATE_WEBHOOK_SECRET` | Self-generated: run `openssl rand -hex 32`. Nothing to configure on Creatomate's side — this is checked entirely by our own code |
| `SUPABASE_SERVICE_ROLE_KEY` | Same value as the backend's `SUPABASE_SERVICE_ROLE_KEY` |
| `RENDER_WORKER_URL` | The worker's Render URL + `/transfer` — Render dashboard > `render-transfer-worker` service > its URL, e.g. `https://render-transfer-worker.onrender.com/transfer` |
| `WORKER_INTERNAL_SECRET` | The *same* value you generated and set on the worker above — don't generate a second one |

### Quick lookup: which dashboard, for everything

| Dashboard | What you'll copy from it |
|---|---|
| Supabase > Settings > API | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Cloudflare > R2 (account overview) | `R2_ACCOUNT_ID` |
| Cloudflare > R2 > uploads bucket > Manage API Tokens | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` |
| Cloudflare > R2 > renders bucket > Manage API Tokens + Custom Domains | renders-bucket access/secret keys, `R2_RENDERS_BUCKET_NAME`, `R2_RENDERS_PUBLIC_URL` |
| Creatomate > Settings > API Keys | `CREATOMATE_API_KEY` |
| Creatomate > project > Preview SDK | `NEXT_PUBLIC_CREATOMATE_PUBLIC_TOKEN` |
| Render > timeline-editor-backend service page | `NEXT_PUBLIC_API_BASE_URL` (the service's own URL) |
| Render > render-transfer-worker service page | `RENDER_WORKER_URL` (the service's own URL + `/transfer`) |
| Vercel > project page (after first deploy) | `SITE_URL`, and `CORS_ORIGINS` on the backend |
| Your own terminal (`openssl rand -hex 32`) | `CREATOMATE_WEBHOOK_SECRET`, `WORKER_INTERNAL_SECRET` |

---

## Local development (for reference — see `README.md` for the authoritative version)

**Backend** (from `backend/`):
```
uv sync
cp .env.example .env   # fill in Supabase + R2 credentials
uv run uvicorn src.main:app --reload
uv run pytest -v
```

**Worker** (from `worker/`):
```
npm install
cp .env.example .env   # fill in Supabase + renders-bucket R2 credentials
npm start
```

**Frontend** (from `frontend/`):
```
npm install
cp .env.local.example .env.local   # fill in Supabase, Creatomate, and backend/worker URLs
npm run dev
```
