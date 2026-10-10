# Deployment Guide

This app is split across four deployed pieces, deliberately (see `README.md`
for the full architecture diagram and the reasoning behind each split):

| Platform | What lives there | Why not somewhere else |
|---|---|---|
| **Vercel** | `frontend/` (Next.js, App Router) | Standard Next.js host. Export is local in-browser, so no render service is needed — see `README.md`'s "Rendering". |
| **Render** | `backend/` (FastAPI) | Owns Supabase's service-role key and the private uploads R2 bucket — no storage credential ever reaches the browser. |
| **Supabase** | Postgres (`users`, `projects`, `assets`) + Auth | Only hosts Postgres/Auth — can't run the backend itself. |
| **Cloudflare R2** | Two buckets: private uploads, public (cover thumbnails, library assets, shared recordings) | S3-compatible object storage. Kept as two buckets because a Cloudflare custom domain makes an *entire* bucket publicly readable, and only one of these should be public. |

Deploy in this order — each later step needs credentials or a URL from an
earlier one.

---

## 0. Prerequisites

- [ ] Supabase account + a new project created
- [ ] Cloudflare account with R2 enabled
- [ ] Render account, connected to this repo
- [ ] Vercel account, connected to this repo
- [ ] A DeepSeek account + API key (platform.deepseek.com) — powers the
      niche-config generation feature (see README.md's "Niches" section);
      swap for Anthropic instead by setting `LLM_PROVIDER=anthropic`

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
   - `0004_add_listing_fields_and_timeline_shape.sql` — adds generic
     `niche`/`attributes` (jsonb) to `projects` (never real-estate-specific
     columns — see README.md), and fixes `timeline`'s default to the shape
     actually used by the editor.
   - `0005_widen_assets_for_voiceover.sql` — widens `assets.kind`/`mime_type`
     to allow `'audio'`/`'audio/mpeg'` (voiceover, once that feature lands).
   - `0006_create_usage_events.sql` — `usage_events` table, the abuse-rate-limit
     guardrail (not billing — see README.md's "Abuse guardrails").
   - `0007_create_project_shares.sql` — `project_shares` table (schema only;
     no route/UI uses it yet).
   - `0008_create_niche_configs.sql` — `niche_configs`, the shared, LLM-generated
     per-niche form-field cache (see README.md's "Niches").
   - `0015_create_roles_and_permissions.sql` — `roles`/`role_features` tables
     (admin-creatable roles with fine-grained feature access, replacing
     `profiles.role`'s old fixed check-constraint enum) plus seeds
     `admin`/`free_user`/`paid_user`. It assigns none of them to any real
     user, so the very first admin still has to be set by hand:
     `update public.profiles set role = 'admin' where user_id = '<uuid>';`
     (or `insert into public.profiles (user_id, role) values ('<uuid>', 'admin') on conflict (user_id) do update set role = 'admin';`
     if that user has no `profiles` row yet). Every other role assignment can
     then be done from `/admin/users`.
   - `0020_drop_assets_storage_key_unique.sql` — drops the leftover unique
     constraint on `assets.storage_key` from `0001`, which contradicted
     `0009`'s content-hash dedup (multiple asset rows are meant to share a
     storage_key) and caused every cross-project dedup hit to fail the
     insert with a `23505` duplicate-key error.
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
3b. **OAuth Providers** (Authentication > Providers) — optional, powers the
   "Continue with Google/Facebook" buttons on `/login` and `/signup`
   (`SocialLoginButtons.tsx`). Skip this section entirely if you only want
   email/password auth; the buttons still render either way, but clicking
   one just fails with whatever error Supabase returns for a disabled
   provider.
   - **Google**: in [Google Cloud Console](https://console.cloud.google.com/)
     create an OAuth consent screen (External, unless every user is inside
     your own Workspace org) and an OAuth Client ID of type "Web
     application." Its **Authorized redirect URI** must be Supabase's own
     callback — `https://<your-project-ref>.supabase.co/auth/v1/callback`
     — copy the exact value shown on the Google provider's config page in
     the Supabase dashboard, not this app's own `/auth/callback` route
     (that's a second hop: Google redirects to Supabase first, which then
     redirects to whichever `redirectTo` `SocialLoginButtons.tsx` passed).
     Paste the resulting Client ID and Client Secret into Supabase's Google
     provider settings and toggle it on.
   - **Facebook**: in [Meta for Developers](https://developers.facebook.com/),
     create an app, add the "Facebook Login" product, and set its **Valid
     OAuth Redirect URI** to that same Supabase callback URL. Paste the
     App ID and App Secret into Supabase's Facebook provider settings and
     toggle it on.
   - No changes needed to this app's own Redirect URLs allow-list from step
     3a above — `app/auth/callback/route.ts` lives under the same origin
     already covered by its `/**` wildcard entries.
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

   `SUPABASE_SERVICE_ROLE_KEY` is used only by the backend — never set it
   on the frontend.

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

5. **After the backend's env vars are set** (step 3 below), apply a CORS
   policy to this bucket — presigned GET URLs point straight at R2's own
   origin, so the backend's `CORS_ORIGINS`/CORSMiddleware setting has *no*
   effect on them; without this, the browser's client-side video editor
   (canvas frame extraction, Web Audio decode) fails with a tainted-canvas
   or blocked-fetch error even though `<video>` playback still works fine:

   ```
   cd backend && uv run python scripts/configure_r2_cors.py
   ```

   This applies GET/HEAD access for whatever origins are already in
   `CORS_ORIGINS` (frontend origins only — never re-run this against the
   public renders bucket, which needs no CORS policy of its own). Re-run it
   whenever `CORS_ORIGINS` changes (e.g. adding a new Vercel URL).

### 2b. Public bucket (CDN-fronted; cover thumbnails)

1. Create a **second, separate** bucket, e.g. `<R2_RENDERS_BUCKET_NAME>`.
2. **This bucket > Settings > Public access > Custom Domains** — connect a
   subdomain, e.g. `videos.yourapp.com`. Cloudflare provisions the DNS record
   for you (a proxied `CNAME`) — you don't hand-write one in the Cloudflare
   DNS tab yourself. This is what makes delivery global/cached with zero
   egress fees.
3. **Create a separate API token** scoped to *only* this bucket, with
   read/write/delete permission — do not reuse the uploads bucket's token.
   The backend uses it to write cover thumbnails — the uploads bucket's own token is never
   used for the renders bucket, and vice versa.
4. Collect:

   | Value | Placeholder used below |
   |---|---|
   | Access Key ID | `<R2_RENDERS_ACCESS_KEY_ID>` |
   | Secret Access Key | `<R2_RENDERS_SECRET_ACCESS_KEY>` |
   | Bucket name | `<R2_RENDERS_BUCKET_NAME>` |
   | Custom domain, with scheme, no trailing slash | `<R2_RENDERS_PUBLIC_URL>` (e.g. `https://videos.yourapp.com`) |

   (`R2_ACCOUNT_ID` is shared — both buckets live under the same account.)

---

## 3. Backend (Render)

1. **New > Blueprint**, connect this repo — Render auto-detects
   `render.yaml`'s `timeline-editor-backend` service (root dir `backend/`).
2. Fill in every variable below in the service's **Environment** tab:

   | Variable | Required | Value |
   |---|---|---|
   | `SUPABASE_URL` | ✅ | `<SUPABASE_URL>` |
   | `SUPABASE_SERVICE_ROLE_KEY` | ✅ | `<SUPABASE_SERVICE_ROLE_KEY>` |
   | `SUPABASE_JWT_SECRET` | optional (recommended) | Any non-empty value turns on local token verification (vs. a network round trip per request). If your project has one, use Supabase **Settings > API > JWT Settings > Legacy JWT Secret** — but on projects using Supabase's asymmetric JWT Signing Keys (e.g. ES256) that value is never checked (verification uses Supabase's public JWKS via `SUPABASE_URL` instead), so any placeholder works. Auth still works if left blank, just slower |
   | `R2_ACCOUNT_ID` | ✅ | `<R2_ACCOUNT_ID>` |
   | `R2_ACCESS_KEY_ID` | ✅ | `<R2_ACCESS_KEY_ID>` |
   | `R2_SECRET_ACCESS_KEY` | ✅ | `<R2_SECRET_ACCESS_KEY>` |
   | `R2_BUCKET_NAME` | ✅ | `<R2_BUCKET_NAME>` |
   | `R2_RENDERS_ACCESS_KEY_ID` | ✅ | `<R2_RENDERS_ACCESS_KEY_ID>` (the renders-bucket token from step 2b above; used to write public media: thumbnails, library assets, shared recordings) |
   | `R2_RENDERS_SECRET_ACCESS_KEY` | ✅ | `<R2_RENDERS_SECRET_ACCESS_KEY>` |
   | `R2_RENDERS_BUCKET_NAME` | ✅ | `<R2_RENDERS_BUCKET_NAME>` |
   | `CORS_ORIGINS` | ✅ | `<YOUR_VERCEL_URL>` (exact scheme, no trailing slash; comma-separate multiple origins) |
   | `DEEPSEEK_API_KEY` | ✅ (unless using Anthropic) | `<DEEPSEEK_API_KEY>` |
   | `LLM_PROVIDER` | optional | `deepseek` (or `anthropic`) |
   | `DEEPSEEK_MODEL` | optional | `deepseek-chat` |
   | `ANTHROPIC_API_KEY` | required if `LLM_PROVIDER=anthropic` | `<ANTHROPIC_API_KEY>` |
   | `ANTHROPIC_MODEL` | optional | `claude-sonnet-5` |
   | `MAX_UPLOAD_SIZE_MB` | optional | `500` |
   | `R2_SIGNED_URL_EXPIRES_SECONDS` | optional | `3600` |
   | `PEXELS_API_KEY` | optional (stock photo/video search disabled without it) | `<PEXELS_API_KEY>` |
   | `FREESOUND_API_KEY` | optional (stock music search disabled without it) | `<FREESOUND_API_KEY>` |
   | `GOOGLE_OAUTH_CLIENT_ID` | required for the YouTube posting feature | Google Cloud Console > **APIs & Services > Credentials** > create an OAuth Client ID (type "Web application") — **a separate client from whatever one Supabase's own Google login button uses** (step 3b above): that one only requests an identity scope, this one requests `youtube.upload` + `youtube.readonly` and needs a stored refresh token. Its **Authorized redirect URI** must be exactly `<YOUR_RENDER_BACKEND_URL>/api/social/youtube/callback`. While the OAuth consent screen is unverified (the normal state for a POC), add your own Google account as a **Test user** or every consent attempt will be blocked |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | required for the YouTube posting feature | Same credential screen as above |
   | `META_APP_ID` | required for the Facebook/Instagram posting feature | [Meta for Developers](https://developers.facebook.com/) > create an app (type "Business") > **App settings > Basic** — **a separate app from whatever one Supabase's own Facebook login button uses** (step 3b above): that one only requests an identity scope for signing in, this one requests `pages_manage_posts`/`instagram_content_publish` and posts on the user's behalf (see `META_APP_REVIEW.md` for the full permissions rationale). Add the "Facebook Login" product and set its **Valid OAuth Redirect URI** to exactly `<YOUR_RENDER_BACKEND_URL>/api/social/meta/callback` — note this is the ONLY redirect URI this feature needs; posting to Instagram rides along with the same Facebook connect (see `backend/src/social/providers/meta_provider.py`'s own comment), it never runs its own OAuth flow. While the app is in Development mode (the normal state for a POC, before Business Verification), add your own Facebook account as a **Test user/Tester** under **App roles** or every consent attempt will be blocked, and only a test Page/Instagram Business account you administer can be connected |
   | `META_APP_SECRET` | required for the Facebook/Instagram posting feature | Same **App settings > Basic** screen as above |
   | `SOCIAL_OAUTH_STATE_SECRET` | required for the YouTube/Meta posting features | Self-generated: `openssl rand -hex 32` — shared across every social provider's connect flow |
   | `FRONTEND_PUBLIC_URL` | required for the YouTube/Meta posting features | This app's own production frontend URL — same value as the frontend's own `SITE_URL` (step 5) — lets the OAuth callback redirect the browser back to `/settings` once a platform is connected |
   | `BACKEND_PUBLIC_URL` | required for video background removal and the YouTube/Meta posting features | this same backend's own Render URL, e.g. `https://<your-backend>.onrender.com` (no trailing slash) -- lets it hand fal.ai/Google/Meta a callback/redirect URL pointing back at itself |
   | `FAL_API_KEY` | required for the background-removal feature (video AND photo cutaways) AND the "Generate from photo" avatar feature | [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) — pay-per-use, calls VEED's video background removal, fal-ai/imageutils/rembg (photos), and fal-ai/image-editing/cartoonify (avatar photo generation) |
   | `SARVAM_API_KEY` | optional — enables the premium Sarvam (Bulbul) Indian-language voices; blank hides them. Each account gets a one-time trial of `SARVAM_TRIAL_CREDIT_CHARS` (default 3000) characters; also `SARVAM_DAILY_CAP` (30), `SARVAM_MODEL` (`bulbul:v2`), `SARVAM_COST_CENTS_PER_CHAR`. Needs migration 0048 | [dashboard.sarvam.ai](https://dashboard.sarvam.ai) — pay-per-character |
   | `FAL_WEBHOOK_SECRET` | required for VIDEO cutaway background removal only | any long random string you generate — appended as a query param on the callback URL handed to fal, and checked against fal's own signed-webhook headers when present; see `matting/providers/fal_veed_provider.py`'s own comment. A photo cutaway's own job is synchronous (no webhook), so this isn't needed for that path |
   | `MATTING_DAILY_CAP` | optional | `20` — real cost is a few cents/clip |
   | `AVATAR_GENERATE_DAILY_CAP` | optional | `10` — real cost now (fal.ai cartoonify, ~$0.10/image, only charged when a face was actually detected -- see below), so this is a budget guard as well as an abuse guard |
   | `FACE_ANALYSIS_SERVICE_URL` | required for the "Generate from photo" avatar feature | `<YOUR_FACE_ANALYSIS_RENDER_URL>` (no trailing slash) — see step 4 below |
   | `FACE_ANALYSIS_SERVICE_SECRET` | required for the "Generate from photo" avatar feature | Self-generated: `openssl rand -hex 32` — must exactly match the same-named env var set on the face-analysis service in step 4 |

   The "Generate from photo" avatar feature (`backend/src/avatar_gen/`) calls
   out to a separate `face-analysis/` service (step 4 below) over HTTPS
   rather than running mediapipe in-process here -- Render's native Python
   runtime has no apt/root access to install the Mesa/GLES/EGL system
   libraries mediapipe's compiled bindings need, which silently made every
   photo analysis on Render fail closed to a generic (non-personalized)
   default. It's called TWICE per generation: once on the original upload
   (a free, local face-detection gate -- no external spend happens unless
   this finds a clear face) and, only if that succeeds, once again on the
   fal.ai-cartoonified result (to get real pixel crop coordinates for the
   head/mouth). A face-analysis call failure of any kind (unreachable
   service, timeout, bad secret) or a fal.ai failure both degrade gracefully
   to the free parametric-drawing fallback rather than failing the request
   -- see `photo_analysis.py`'s and `service.py`'s own comments.

   The background-removal feature (cutting a cutaway's subject out to
   composite over a new backdrop, via fal.ai/VEED for video, fal.ai/rembg
   for a Ken Burns photo cutaway) is likewise optional -- without
   `FAL_API_KEY` (both kinds) or `FAL_WEBHOOK_SECRET`/`BACKEND_PUBLIC_URL`
   (video only), the editor's "Remove background" toggle 500s with a clear
   "not configured"
   message instead of starting a job.

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

## 4. Face analysis (Render, Docker)

A separate, minimal service (`face-analysis/`) that runs mediapipe's
`FaceLandmarker` against an uploaded photo and returns a small JSON palette
(skin/hair tone, face-width scale) -- everything the backend's
`avatar_gen/service.py` needs to generate a personalized avatar skin. It's
its own Docker-deployed service, not part of the main Render backend, purely
because Render's *native* Python runtime can't install the Mesa/GLES/EGL
system libraries mediapipe's compiled bindings need (no apt/root access, see
step 3's own note on `libGLESv2.so.2`) -- owning the base image via Docker
fixes that. This previously ran on Google Cloud Run with an attached GPU;
that GPU was dropped early on (a GCP GPU-quota wall) and the service has run
CPU-only ever since, so there was no longer any reason to pay Cloud Run's
per-request billing for what's just another small always-on web service --
moved to Render (same free tier as the rest of this POC) instead.

1. In the same Blueprint as the backend's Render service (`render.yaml`'s
   `face-analysis` entry, `runtime: docker`, root dir `face-analysis/`),
   Render builds directly from `face-analysis/Dockerfile` -- no separate
   container registry or build pipeline to set up.
2. **Environment variables**: `FACE_ANALYSIS_SERVICE_SECRET` (`openssl rand
   -hex 32` -- copy this exact value into the backend's own env var of the
   same name, step 3 above). Leave `FACE_ANALYSIS_USE_GPU` unset/`false` --
   there's no GPU on Render, and the CPU delegate is the already-verified
   path.
3. Deploy, then verify:
   ```
   curl https://<your-face-analysis-service>.onrender.com/health
   # -> {"status": "ok"}
   ```
4. Copy this service's URL into the backend's `FACE_ANALYSIS_SERVICE_URL`
   env var (step 3 above) and redeploy the backend.
5. Try "Generate from photo" in the editor with a real, clear, front-facing
   photo. If it still falls back to a generic look, check this service's
   Render logs first, then the backend's own logs (a face-analysis call
   failure of any kind degrades gracefully and logs why).

If you already have a Cloud Run deployment from before this move, delete it
once the Render service is verified working -- otherwise it keeps billing
for nothing.

---

## 5. Frontend (Vercel)

1. **Import project**, set **Root Directory** to `frontend`.
2. Framework preset: Next.js (auto-detected).
3. Set these **Project Settings > Environment Variables**:

   **Public (`NEXT_PUBLIC_*`, baked into the browser bundle at build time):**

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `<SUPABASE_URL>` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `<SUPABASE_ANON_KEY>` |
   | `NEXT_PUBLIC_API_BASE_URL` | `<YOUR_RENDER_BACKEND_URL>` (e.g. `https://timeline-editor-backend.onrender.com`, no trailing slash) |

   **Secret (server-only — do NOT prefix with `NEXT_PUBLIC_`):**

   | Variable | Value |
   |---|---|
   | `SITE_URL` | see the pitfall below — set this once you know your production URL (used for canonical URLs) |

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
   - Export a reel from the editor and confirm the in-browser export
     downloads a playable video.

---

## 6. Post-deploy smoke test (all pieces live)

- [ ] `GET /health` on the backend URL returns `{"status": "ok"}`
- [ ] Frontend loads; sign-up/login works; `/dashboard` redirects to `/login` when signed out
- [ ] Creating a "New Reel" with a niche you haven't used before returns a generated form within a few seconds (confirms `LLM_PROVIDER`/`DEEPSEEK_API_KEY` work) and is instant the second time (confirms `niche_configs` caching)
- [ ] Video upload succeeds end-to-end from the dashboard (frontend → backend → R2 uploads bucket + Supabase)
- [ ] Exporting a reel from the editor downloads a playable video (local in-browser export)

---

## Spend safety checklist (do before opening signups)

The app enforces per-user caps, site-wide caps and a site-wide cost budget
(`backend/src/usage/limits.py`, migration `0043`). Those only hold if the
provider accounts are also configured so a bug or leaked key can't bill past
them. None of this can be set from code:

- **fal.ai** — keep the account on **prepaid credit with auto-recharge OFF**.
  When the balance hits zero fal locks the account instead of billing more,
  so the worst case is the balance you chose to load. Set a spend/usage alert
  in the fal dashboard. Rotate `FAL_API_KEY` if it was ever pasted anywhere.
- **Cloudflare R2** — has **no spend cap**. Set a billing notification
  (Billing > Notifications) well under what you'd tolerate. Add a bucket
  **lifecycle rule** on the uploads bucket: expire the `avatars-tmp/` prefix
  after 1 day and abort incomplete multipart uploads after 1 day (the temp
  cartoonify source is deleted in code, but a crash between upload and
  cleanup would otherwise leave it forever).
- **Supabase Auth** — per-user caps are meaningless if anyone can mint
  accounts for free. Turn on **Confirm email**, enable **CAPTCHA protection**
  (Cloudflare Turnstile) for sign-up, and make sure **Anonymous sign-ins** is
  **off**. Review the Auth rate-limit settings.
- **Roles** — only `paid_user`/`admin` carry `matting_generate` and
  `avatar_generate`. Re-check `/admin/roles` before adding either feature to a
  role that new signups receive (`free_user` must not have them).
- **Watch it** — `/admin/usage` lists `cap_warnings`. Entries ending in
  `_site` or `_budget` mean a site-wide limit was hit: someone is either
  growing fast or abusing; look before raising the limit.

## Common pitfalls

1. **"Env var set but not applied."** Vercel bakes `NEXT_PUBLIC_*` vars into
   the JS bundle at *build* time; Render doesn't hot-reload env vars into a
   running instance. Both need a **fresh deploy after** changing a value —
   saving it in the dashboard alone does nothing until the next build/restart.
2. **`SITE_URL` left unset in production.** Without it, canonical URLs fall
   back to Vercel's own `VERCEL_URL`, which isn't guaranteed stable across
   deployments. Set `SITE_URL` explicitly to your production domain once you
   have one.
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
6. **Public custom domain on the wrong bucket.** If asset URLs ever look
   like a permanent public link instead of a presigned URL with an
   `X-Amz-Signature` query string, the uploads bucket has public access
   enabled somewhere — it must stay private. Only the renders bucket (2b)
   should have a custom domain.
7. **`R2_ENDPOINT_OVERRIDE` set in a real environment.** Backend-only, test
   suite-only. If set in Render's dashboard, R2 access silently points at
   the wrong (or no) host.
8. **Cold starts on Render's free tier.** The backend spins down when
   idle — the first request after idle can take 30–60s.

---

## Environment variable reference (complete)

Every row below says exactly where that value comes from — nothing here
should require guessing. "Self-generated" means you invent the value
yourself (a random secret); everything else comes from a specific dashboard.

### Backend (Render), from `backend/src/core/config.py`

| Variable | Default | Where to get it |
|---|---|---|
| `MAX_UPLOAD_SIZE_MB` | `500` | Not fetched — pick a number, optional to set |
| `CORS_ORIGINS` | `http://localhost:3000` | Your Vercel deployment URL (step 5) — Vercel project > **Settings > Domains**, or just the URL shown after your first deploy. Comma-separate if more than one. |
| `SUPABASE_URL` | `""` | Supabase project > **Settings > API > Project URL** |
| `SUPABASE_SERVICE_ROLE_KEY` | `""` | Supabase project > **Settings > API > Project API keys > `service_role`** (click "Reveal") |
| `SUPABASE_JWT_SECRET` | `""` | Any non-empty value turns on local token verification. Use Supabase **Settings > API > JWT Settings > Legacy JWT Secret** if your project has one; on projects using asymmetric JWT Signing Keys (e.g. ES256) that value isn't actually checked (verification uses Supabase's public JWKS instead), so any placeholder works. Optional — left blank, `get_current_user` falls back to a slower `auth.get_user()` network call per request (see `core/auth.py`) |
| `R2_ACCOUNT_ID` | `""` | Cloudflare dashboard > **R2** — Account ID is in the right sidebar of the R2 overview page |
| `R2_ACCESS_KEY_ID` | `""` | Cloudflare > **R2 > Manage API Tokens > Create API Token** (scope: uploads bucket, step 2a) — shown after creating the token |
| `R2_SECRET_ACCESS_KEY` | `""` | Same token-creation screen as above — **shown once only**, copy it immediately |
| `R2_BUCKET_NAME` | `""` | The name you gave the uploads bucket when you created it (step 2a) |
| `R2_RENDERS_ACCESS_KEY_ID` | `""` | The renders-bucket token (step 2b) — used to write public media (thumbnails, library assets, shared recordings) |
| `R2_RENDERS_SECRET_ACCESS_KEY` | `""` | Same token-creation screen as above — shown once, copy immediately |
| `R2_RENDERS_BUCKET_NAME` | `""` | The name you gave the renders bucket when you created it (step 2b) |
| `R2_ENDPOINT_OVERRIDE` | `""` | **Don't set this** — tests only |
| `R2_SIGNED_URL_EXPIRES_SECONDS` | `3600` | Not fetched — pick a number, optional to set |
| `LLM_PROVIDER` | `deepseek` | Not fetched — `deepseek` or `anthropic`, optional to set |
| `DEEPSEEK_API_KEY` | `""` | DeepSeek dashboard > **API Keys** (platform.deepseek.com) |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Not fetched — optional to set |
| `ANTHROPIC_API_KEY` | `""` | Only needed if `LLM_PROVIDER=anthropic` — Anthropic Console > **API Keys** |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Not fetched — optional to set |
| `PEXELS_API_KEY` | `""` | [pexels.com/api](https://www.pexels.com/api/) — sign up, one key covers both photo and video search |
| `FREESOUND_API_KEY` | `""` | [freesound.org/apiv2/apply](https://freesound.org/apiv2/apply/) — request an API credential (basic token auth, no OAuth2 needed) |
| `GOOGLE_OAUTH_CLIENT_ID` | `""` | Google Cloud Console > **APIs & Services > Credentials** — a Web-application OAuth Client ID dedicated to YouTube posting, separate from Supabase's own Google login client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | `""` | Same credential screen as above |
| `SOCIAL_OAUTH_STATE_SECRET` | `""` | Self-generated: `openssl rand -hex 32` |
| `FRONTEND_PUBLIC_URL` | `""` | This app's own production frontend URL — same value as the frontend's `SITE_URL` below |
| `AVATAR_GENERATE_DAILY_CAP` | `10` | Not fetched — pick a number, optional to set |
| `MATTING_DAILY_CAP` | `20` | Per-user background removals per rolling 24h (atomic, see `usage/limits.py`) |
| `MATTING_GLOBAL_DAILY_CAP` | `200` | **Site-wide** background removals per 24h, across all accounts |
| `AVATAR_GENERATE_GLOBAL_DAILY_CAP` | `100` | **Site-wide** avatar generations (fal.ai cartoonify) per 24h |
| `PAID_PROVIDER_DAILY_BUDGET_CENTS` | `500` | **Site-wide** estimated fal.ai spend per 24h, in cents — the number that bounds the bill no matter how many accounts exist. Admins are subject to it too |
| `MATTING_MAX_SOURCE_SECONDS` | `60` | Longest clip one background-removal job may bill for (VEED bills per second) |
| `STORAGE_QUOTA_MB` / `MAX_OBJECTS_PER_USER` | `2048` / `1000` | Per-user private-bucket footprint (assets + recordings + ticket attachments) |
| `LIBRARY_MAX_VIDEO_MB` / `LIBRARY_MAX_VIDEOS_PER_USER` | `200` / `50` | Public-bucket library limits |
| `MAX_AVATARS_PER_USER` | `30` | Saved avatars (generate + duplicate + import all count) |
| `TICKET_MESSAGES_DAILY_CAP` / `LIBRARY_PROMOTIONS_DAILY_CAP` | `30` / `5` | Support replies / public avatar-library publishes per user per day |
| `FACE_ANALYSIS_SERVICE_URL` | `""` | The face-analysis Render service's own URL (below) |
| `FACE_ANALYSIS_SERVICE_SECRET` | `""` | Self-generated: `openssl rand -hex 32` — same value set on the face-analysis service below |

### Face analysis (Render, Docker), from `face-analysis/.env.example`

| Variable | Where to get it |
|---|---|
| `FACE_ANALYSIS_SERVICE_SECRET` | Self-generated: run `openssl rand -hex 32`. Set the *same* value on the backend (above) |
| `FACE_ANALYSIS_USE_GPU` | Leave unset/`false` — Render has no GPU; CPU delegate is the verified path |

### Frontend (Vercel), from `frontend/.env.local.example`

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Same value as the backend's `SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project > **Settings > API > Project API keys > `anon` `public`** — **not** the `service_role` key |
| `NEXT_PUBLIC_API_BASE_URL` | The backend's Render URL — Render dashboard > `timeline-editor-backend` service > the URL shown at the top of its page, e.g. `https://timeline-editor-backend.onrender.com` |
| `SITE_URL` | This app's own production URL, once you know it — Vercel project page after first deploy, or your custom domain if you attach one. Leave unset for the very first deploy (see step 5) |

### Quick lookup: which dashboard, for everything

| Dashboard | What you'll copy from it |
|---|---|
| Supabase > Settings > API | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Cloudflare > R2 (account overview) | `R2_ACCOUNT_ID` |
| Cloudflare > R2 > uploads bucket > Manage API Tokens | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` |
| Cloudflare > R2 > renders bucket > Manage API Tokens + Custom Domains | renders-bucket access/secret keys, `R2_RENDERS_BUCKET_NAME`, `R2_RENDERS_PUBLIC_URL` |
| DeepSeek dashboard > API Keys | `DEEPSEEK_API_KEY` |
| Pexels > API | `PEXELS_API_KEY` |
| Render > face-analysis service page | `FACE_ANALYSIS_SERVICE_URL` (the service's own URL) |
| Freesound > apiv2/apply | `FREESOUND_API_KEY` |
| Google Cloud Console > APIs & Services > Credentials | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| Meta for Developers > your app > App settings > Basic | `META_APP_ID`, `META_APP_SECRET` |
| Render > timeline-editor-backend service page | `NEXT_PUBLIC_API_BASE_URL` (the service's own URL) |
| Vercel > project page (after first deploy) | `SITE_URL`, and `CORS_ORIGINS` on the backend |
| Your own terminal (`openssl rand -hex 32`) | `SOCIAL_OAUTH_STATE_SECRET`, `FACE_ANALYSIS_SERVICE_SECRET` |

---

## Local development (for reference — see `README.md` for the authoritative version)

**Backend** (from `backend/`):
```
uv sync
cp .env.example .env   # fill in Supabase + R2 credentials
uv run uvicorn src.main:app --reload
uv run pytest -v
```

**Frontend** (from `frontend/`):
```
npm install
cp .env.local.example .env.local   # fill in Supabase and backend URL
npm run dev
```
