from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    max_upload_size_mb: int = 500

    cors_origins: str = "http://localhost:3000"

    supabase_url: str = ""
    supabase_service_role_key: str = ""

    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket_name: str = ""
    # Overrides the computed R2 endpoint — set only in tests, to point boto3's
    # S3 client at a local mock server instead of real R2.
    r2_endpoint_override: str = ""
    # How long a presigned asset read URL stays valid -- the R2 bucket is
    # private, so this is the only way a browser ever reads an object. Kept
    # short-ish since a leaked link is live for this long; refresh by
    # re-fetching the asset (list/upload response), not by caching the URL.
    r2_signed_url_expires_seconds: int = 3600

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
