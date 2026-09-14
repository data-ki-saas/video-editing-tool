from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    max_upload_size_mb: int = 500

    cors_origins: str = "http://localhost:3000"

    # Which LLMProvider src.llm.client.get_llm_provider() returns: "deepseek"
    # or "anthropic". Defaults to deepseek here (unlike the sibling ../data
    # project, which defaults to anthropic) -- override per environment via
    # the LLM_PROVIDER env var.
    llm_provider: str = "deepseek"

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5"

    deepseek_api_key: str = ""
    deepseek_model: str = "deepseek-chat"

    # Which TTSProvider src.tts.client.get_tts_provider() returns. Only
    # "edge" exists today (the free, keyless unofficial Edge Read-Aloud API
    # via the edge-tts package) but the setting/switch pattern is kept the
    # same shape as llm_provider above so a paid provider can be added later
    # without a rewrite.
    tts_provider: str = "edge"
    # Abuse guardrail (see usage_events / RENDER_DAILY_LIMIT's frontend
    # equivalent in api/render/route.ts), not billing/metering -- a fixed
    # daily cap per user on voiceover generations.
    tts_daily_cap: int = 15

    # The render daily cap's actual enforcement point is
    # usage/service.py's assert_render_cap, called by
    # frontend/src/app/api/render/route.ts via POST
    # /api/usage/assert-render-cap before it will start a Creatomate render
    # (the render call itself still happens in that Next.js route -- see
    # this repo's root CLAUDE.md on why -- only the cap CHECK lives here).
    # Also feeds GET /api/usage/summary, so this is the one place this
    # number is ever set.
    render_daily_cap: int = 10

    # Abuse guardrail on FILING a support ticket (not replying to one --
    # see tickets/service.py's create_ticket) -- same fixed-daily-cap
    # precedent as tts_daily_cap/render_daily_cap above, backed by the same
    # usage_events table (event_type='ticket_filed', see supabase/migrations/
    # 0029's widened check constraint).
    tickets_daily_cap: int = 10

    # This server's own publicly reachable base URL -- needed so
    # matting/service.py and social/client.py can hand a provider/OAuth
    # flow a callback/redirect URL pointing back at itself (POST
    # /api/render never needed this, since Creatomate's webhook is handled
    # by the Next.js frontend instead -- see
    # frontend/src/app/api/webhooks/creatomate/route.ts). No trailing slash.
    backend_public_url: str = ""

    # Which MattingProvider src.matting.client.get_matting_provider()
    # returns. Only "fal_veed" exists today (VEED's fast/no-refine video
    # background removal, called via fal.ai's queue API) -- same
    # switch-pattern precedent as llm_provider/tts_provider above.
    matting_provider: str = "fal_veed"
    fal_api_key: str = ""
    # Our own shared secret, appended as a query param on the callback_url
    # handed to fal AND checked against fal's own signed-webhook headers
    # when present -- see FalVeedProvider.verify_webhook's own comment on
    # why both checks exist.
    fal_webhook_secret: str = ""
    # Real cost is a few cents/clip ($0.008/sec at VEED's fast/no-refine
    # tier) -- still a hard ceiling per CLAUDE.md's abuse-rate-limiting
    # scope, not billing.
    matting_daily_cap: int = 20
    # No external vendor cost at all (Pillow atlas compositing, see
    # avatar_gen/service.py) -- purely an abuse guard, not a budget guard, so
    # this can afford to be more generous than matting_daily_cap above.
    avatar_generate_daily_cap: int = 10

    # The standalone face-analysis/ Cloud Run (GPU) service -- moved out of
    # this backend because Render's native Python runtime can't load
    # mediapipe's compiled bindings (missing libGLESv2.so.2, no apt/root
    # access to install it; see [[project_avatar_phase6_photo_gen]] and
    # avatar_gen/photo_analysis.py's own doc comment). Left blank,
    # analyze_photo fails closed to a generic-toned avatar rather than
    # erroring the whole generation -- same fail-open-on-the-*feature*,
    # never-fail-open-on-*security* posture as this file's other optional
    # integrations.
    face_analysis_service_url: str = ""
    face_analysis_service_secret: str = ""

    # Estimated external costs backing usage_ledger.cost_estimate_cents (see
    # backend/src/metering/pricing.py) -- hand-maintained placeholders, not
    # live provider rates. Cross-reference frontend/src/app/admin/integrations
    # page.tsx's pricingNote text and keep both in sync by hand, same
    # precedent as render_daily_cap mirroring RENDER_DAILY_LIMIT above.
    creatomate_cost_cents_per_second: float = 2.5
    # VEED's fast/no-refine tier, per fal.ai's published per-30-frames rate
    # at 30fps ($0.008/30 frames = $0.008/sec) -- an actual published rate,
    # unlike most of this block's placeholders.
    veed_cost_cents_per_second: float = 0.8
    # fal-ai/imageutils/rembg (a photo's own background-removal path, see
    # matting/service.py's image-kind branch) bills by compute-second
    # ($0.00111/compute-second per fal's published rate) rather than a flat
    # per-image price -- this is a rough placeholder flat estimate (a
    # typical single-image inference), not a real per-request measurement.
    rembg_cost_cents_per_image: float = 0.15
    tts_cost_cents_per_second: float = 0.0  # edge-tts is free
    deepseek_cost_cents_per_1k_tokens: float = 0.14
    anthropic_cost_cents_per_1k_input_tokens: float = 0.3
    anthropic_cost_cents_per_1k_output_tokens: float = 1.5

    supabase_url: str = ""
    supabase_service_role_key: str = ""
    # Project Settings > API > JWT Settings > "Legacy JWT Secret" -- lets
    # get_current_user verify an access token's signature locally (HS256)
    # instead of a network round trip to Supabase Auth on every request. Left
    # unset, auth.py falls back to that slower remote check, so this is safe
    # to leave blank until you copy the value in (see DEPLOY.md).
    supabase_jwt_secret: str = ""

    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket_name: str = ""
    # The finished-renders bucket is public (fed by worker/, see its own
    # README) and secured by a SEPARATE API token from the uploads bucket
    # above (see DEPLOY.md step 2b). Originally only used so
    # projects/service.py could delete a project's render object on reel
    # delete -- worker/ owned every write here. The thumbnail/cover picker
    # is the one exception: projects/service.py's upload_thumbnail writes a
    # cover image straight to this bucket itself (the token already has
    # write permission, per DEPLOY.md), since that upload is a synchronous
    # request/response, not a Creatomate render worker/ mirrors after the
    # fact.
    r2_renders_access_key_id: str = ""
    r2_renders_secret_access_key: str = ""
    r2_renders_bucket_name: str = ""
    # Same value as the worker's R2_RENDERS_PUBLIC_URL env var -- lets the
    # backend construct a public URL for an object it just wrote (uploaded
    # thumbnails), the same way worker/src/server.js does for renders.
    r2_renders_public_url: str = ""
    # Overrides the computed R2 endpoint — set only in tests, to point boto3's
    # S3 client at a local mock server instead of real R2.
    r2_endpoint_override: str = ""
    # How long a presigned asset read URL stays valid -- the R2 bucket is
    # private, so this is the only way a browser ever reads an object. Kept
    # short-ish since a leaked link is live for this long; refresh by
    # re-fetching the asset (list/upload response), not by caching the URL.
    r2_signed_url_expires_seconds: int = 3600

    # Pexels (https://www.pexels.com/api/) -- stock photo/video search.
    pexels_api_key: str = ""

    # Freesound (https://freesound.org/apiv2/apply/) -- stock background-
    # music search. Results are filtered server-side to CC0-licensed tracks
    # only (see stock_media/freesound_client.py), so a key with basic token
    # auth is all that's ever needed -- no OAuth2, since only preview-quality
    # audio is imported, not the OAuth2-gated original-quality download.
    freesound_api_key: str = ""

    # Google OAuth client used ONLY for posting a saved reel to YouTube on a
    # user's behalf (src/social/) -- a SEPARATE OAuth client from whatever
    # one Supabase's own "Continue with Google" login button uses (see
    # DEPLOY.md's step 3b): that one only ever requests an identity scope,
    # this one needs youtube.upload plus a stored refresh token.
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    # Meta (Facebook Login) app used for posting to a connected Facebook
    # Page and/or its linked Instagram Business account (src/social/
    # providers/meta_provider.py) -- see META_APP_REVIEW.md for the
    # permissions requested and why. One app serves both the "meta" and
    # "instagram" provider keys; only "meta" ever initiates the OAuth
    # flow (see client.py), so only one Valid OAuth Redirect URI needs
    # registering with Meta.
    meta_app_id: str = ""
    meta_app_secret: str = ""
    # Signs/verifies the OAuth "state" param round-tripped through Google's
    # consent screen (CSRF protection, and carries which user started the
    # connect flow, since the callback has no session/bearer token to read
    # one from -- Google redirects the browser there directly). Self-
    # generated, same precedent as CREATOMATE_WEBHOOK_SECRET/
    # FAL_WEBHOOK_SECRET: `openssl rand -hex 32`.
    social_oauth_state_secret: str = ""
    # This app's own frontend origin -- lets social/service.py's OAuth
    # callback redirect the browser back to /settings once a platform is
    # connected. Mirrors backend_public_url above, just the other direction
    # (the frontend's own address, not this server's).
    frontend_public_url: str = ""

    @property
    def max_upload_size_bytes(self) -> int:
        return self.max_upload_size_mb * 1024 * 1024

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def r2_endpoint_url(self) -> str:
        return self.r2_endpoint_override or f"https://{self.r2_account_id}.r2.cloudflarestorage.com"


settings = Settings()
