import logging
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from src.assets.router import router as assets_router
from src.avatar.router import router as avatar_router
from src.core.config import settings
from src.matting.router import router as matting_router
from src.metering.router import router as metering_router
from src.niches.router import router as niches_router
from src.permissions.router import router as permissions_router
from src.projects.router import router as projects_router
from src.stock_media.router import router as stock_media_router
from src.tts.router import router as tts_router
from src.usage.router import router as usage_router

# Render's log stream is the only visibility into a deployed failure -- there's
# no APM/observability stack here, so a plain root logger configured once at
# import time is what "check the logs" actually means for this app.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    app = FastAPI(title="Reel Creator")

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

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        """A truly unhandled exception is caught by Starlette's outermost
        error-handling layer, which sits OUTSIDE CORSMiddleware -- so the
        response it generates never gets a CORS header attached, and the
        browser reports "blocked by CORS policy" for what is actually a
        500. Registering a handler here keeps the response inside the
        normal middleware stack instead, so CORSMiddleware still runs on
        it -- the frontend gets a real error message instead of a
        misleading CORS symptom for whatever crashed."""
        logger.exception("Unhandled exception for %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={"detail": "Internal server error"})

    app.include_router(assets_router)
    app.include_router(avatar_router)
    app.include_router(matting_router)
    app.include_router(metering_router)
    app.include_router(niches_router)
    app.include_router(permissions_router)
    app.include_router(projects_router)
    app.include_router(stock_media_router)
    app.include_router(tts_router)
    app.include_router(usage_router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
