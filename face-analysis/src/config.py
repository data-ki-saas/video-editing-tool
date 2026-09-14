from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Shared secret backend/src/avatar_gen/photo_analysis.py sends as
    # `x-internal-secret` -- same header name/timing-safe-compare convention
    # as worker/src/server.js's WORKER_INTERNAL_SECRET, just a separate
    # secret (different caller). Generate with `openssl rand -hex 32`, same
    # precedent as this repo's other self-generated secrets.
    face_analysis_service_secret: str = ""

    # Attempt mediapipe's GPU delegate before falling back to CPU (see
    # photo_analysis.py's own comment on why this is try-then-fallback, not
    # assumed to work) -- only meaningful when this service is actually
    # deployed on a GPU-attached Cloud Run instance. Defaults off: this
    # service dropped its GPU (Cloud Run GPU quota wall, see
    # [[project_face_analysis_service]]) and now always runs CPU-only.
    face_analysis_use_gpu: bool = False


settings = Settings()
