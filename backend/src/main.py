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
        error-handling layer (ServerErrorMiddleware). Registering a plain
        `Exception` handler here does NOT run inside CORSMiddleware like a
        handler for a specific exception type would -- Starlette special-
        cases the bare `Exception`/500 key and wires it directly into
        ServerErrorMiddleware itself (see Starlette's Starlette.__init__:
        `if key in (500, Exception): error_handler = value`), which sits
        OUTSIDE CORSMiddleware in the middleware stack. So the response this
        handler returns never passes back through CORSMiddleware, and the
        browser reports "blocked by CORS policy" / "Failed to fetch" for
        what is actually a 500 -- confirmed 2026-09-04 against a real
        edge_tts.NoAudioReceived crash reported as a CORS error on the
        frontend despite CORS_ORIGINS being configured correctly. Fixed by
        echoing the same Access-Control-Allow-* headers CORSMiddleware
        itself would have added, directly on this response, rather than
        relying on middleware ordering we don't control."""
        logger.exception("Unhandled exception for %s %s", request.method, request.url.path)
        response = JSONResponse(status_code=500, content={"detail": "Internal server error"})
        origin = request.headers.get("origin")
        if origin in settings.cors_origin_list:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
        return response

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
