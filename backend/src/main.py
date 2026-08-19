import logging
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from src.assets.router import router as assets_router
from src.core.config import settings

# Render's log stream is the only visibility into a deployed failure -- there's
# no APM/observability stack here, so a plain root logger configured once at
# import time is what "check the logs" actually means for this app.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    app = FastAPI(title="Timeline Editor")

    # Logged at startup so a misconfigured/empty CORS_ORIGINS on Render (the
    # most common cause of a browser-side "Failed to fetch" on upload) shows
    # up immediately in the deploy logs instead of only being discoverable by
    # inspecting the failing request's Network tab.
    logger.info("CORS allow_origins=%s", settings.cors_origin_list)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        start = time.monotonic()
        response = await call_next(request)
        duration_ms = (time.monotonic() - start) * 1000
        logger.info(
            "%s %s origin=%s -> %s (%.1fms)",
            request.method,
            request.url.path,
            request.headers.get("origin"),
            response.status_code,
            duration_ms,
        )
        return response

    app.include_router(assets_router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
