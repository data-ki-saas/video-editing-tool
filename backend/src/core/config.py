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

    supabase_url: str = ""
    supabase_service_role_key: str = ""

    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket_name: str = ""
    # The finished-renders bucket is public (fed by worker/, see its own
    # README) and secured by a SEPARATE API token from the uploads bucket
    # above (see DEPLOY.md step 2b) -- these three exist only so
    # projects/service.py can delete a project's render object on reel
    # delete; nothing here ever writes to this bucket, worker/ does that.
    r2_renders_access_key_id: str = ""
    r2_renders_secret_access_key: str = ""
    r2_renders_bucket_name: str = ""
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
