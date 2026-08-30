import io
import json
import logging
import time
import uuid

import httpx
from fastapi import HTTPException
from mutagen.mp4 import MP4

from src.assets import repository as assets_repository
from src.assets.service import store_asset_bytes
from src.avatar import repository as avatar_repository
from src.avatar.client import get_avatar_provider
from src.avatar.schemas import AvatarGenerationDetail, AvatarOptionResponse, GenerateAvatarVideoResponse
from src.core.auth import CurrentUser
from src.core.config import settings
from src.metering import pricing as metering_pricing
from src.metering import repository as metering_repository
from src.storage import r2_client

logger = logging.getLogger(__name__)

# Unlike TTS's static voice list, an avatar catalog is a live call to
# HeyGen (see HeyGenProvider.list_avatars) -- worth a short cache so the
# wizard's Review step doesn't hit their API on every load. Simple
# module-level TTL cache, not a full caching layer -- one process, one
# avatar provider, no need for anything heavier.
_AVATAR_CACHE_TTL_SECONDS = 3600
_avatar_cache: tuple[float, list[AvatarOptionResponse]] | None = None

# Matches this app's fixed 9:16 reel output (see frontend's REEL_WIDTH/
# REEL_HEIGHT) -- there's no per-project aspect-ratio choice on this path
# yet since the wizard's own output is always 9:16 today.
ASPECT_RATIO = "9:16"


def _build_callback_url() -> str:
    base = settings.backend_public_url.rstrip("/")
    return f"{base}/api/avatar/webhooks/heygen?secret={settings.heygen_webhook_secret}"


async def generate(
    project_id: str, audio_asset_id: str, avatar_id: str | None, user: CurrentUser
) -> GenerateAvatarVideoResponse:
    if not assets_repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")

    audio_asset = assets_repository.get_asset(audio_asset_id, user.id)
    if audio_asset is None or audio_asset.project_id != project_id:
        raise HTTPException(status_code=404, detail="Audio asset not found in this project")
    if audio_asset.kind != "audio":
        raise HTTPException(status_code=400, detail="That asset isn't audio")

    # Fails OPEN on a usage_events read error, same precedent as
    # tts/service.py's own cap check -- but unlike TTS, a miss here spends
    # real money at the provider, so avatar_daily_cap should stay small (see
    # its own comment in core/config.py).
    recent_count = avatar_repository.count_recent_avatar_events(user.id)
    if recent_count is not None and recent_count >= settings.avatar_daily_cap:
        raise HTTPException(
            status_code=429,
            detail=f"You've reached the limit of {settings.avatar_daily_cap} avatar videos per day. Try again tomorrow.",
        )

    resolved_avatar_id = avatar_id or settings.heygen_default_avatar_id
    if not resolved_avatar_id:
        raise HTTPException(status_code=500, detail="No avatar is configured for this server yet")
    if not settings.backend_public_url or not settings.heygen_webhook_secret:
        raise HTTPException(status_code=500, detail="Avatar video generation isn't configured on this server yet")

    audio_url = r2_client.presigned_get_url(audio_asset.storage_key)

    try:
        handle = await get_avatar_provider().create_video(
            audio_url=audio_url,
            avatar_id=resolved_avatar_id,
            aspect_ratio=ASPECT_RATIO,
            callback_url=_build_callback_url(),
        )
    except Exception as exc:
        logger.exception("avatar video creation failed for project=%s", project_id)
        raise HTTPException(status_code=502, detail="Couldn't start avatar video generation -- try again") from exc

    avatar_repository.create_generation(
        id=handle.provider_video_id, project_id=project_id, user_id=user.id, avatar_id=resolved_avatar_id
    )
    # Best-effort, same as tts/service.py's record_voiceover_event -- a
    # failure here shouldn't fail a generation that was already kicked off.
    avatar_repository.record_avatar_event(user.id)

    return GenerateAvatarVideoResponse(id=handle.provider_video_id, status="waiting")


def get_generation(id: str, user: CurrentUser) -> AvatarGenerationDetail:
    record = avatar_repository.get_generation(id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Avatar generation not found")

    url = None
    if record.asset_id is not None:
        # Re-derived fresh rather than persisted -- same not-permanent-link
        # reasoning as every other asset (see Asset.url's own comment).
        asset = assets_repository.get_asset(record.asset_id, user.id)
        url = r2_client.presigned_get_url(asset.storage_key) if asset else None

    return AvatarGenerationDetail(
        id=record.id, status=record.status, asset_id=record.asset_id, url=url, error=record.error
    )


async def handle_webhook(*, raw_body: bytes, headers: dict[str, str], query_secret: str | None) -> None:
    provider = get_avatar_provider()
    if not provider.verify_webhook(raw_body=raw_body, headers=headers, query_secret=query_secret):
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    try:
        payload = json.loads(raw_body)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Request body must be valid JSON") from exc

    event = provider.parse_webhook(payload)
    if not event.provider_video_id:
        logger.error("avatar webhook payload had no recognizable video id: %r", payload)
        raise HTTPException(status_code=400, detail="Unrecognized payload")

    generation = avatar_repository.get_generation_by_id(event.provider_video_id)
    if generation is None:
        # A stale/replayed delivery, or one for a generation this app never
        # recorded -- acknowledge rather than inviting a retry storm, same
        # "no matching row" handling as the Creatomate webhook.
        logger.warning("avatar webhook for unrecognized generation id=%s", event.provider_video_id)
        return

    if event.status == "failed" or not event.video_url:
        avatar_repository.mark_failed(generation.id, event.error or "Avatar video generation failed")
        return

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(event.video_url)
        response.raise_for_status()
        video_bytes = response.content
        asset = store_asset_bytes(
            project_id=generation.project_id,
            user=CurrentUser(id=generation.user_id, email=None),
            filename=f"avatar-{uuid.uuid4().hex}.mp4",
            content_type="video/mp4",
            kind="video",
            body=video_bytes,
        )
    except Exception:
        # Marked failed (a terminal state) rather than left "waiting" --
        # HeyGen retries failed webhook DELIVERIES (non-2xx), not a delivery
        # that succeeded but whose handling errored afterward, so leaving
        # this waiting would mean it never resolves.
        logger.exception("failed to store finished avatar video for generation=%s", generation.id)
        avatar_repository.mark_failed(generation.id, "Failed to save the finished avatar video")
        return

    avatar_repository.mark_completed(generation.id, asset.id)

    # HeyGen exposes no duration anywhere in its request, response, or
    # webhook payload (see HeyGenProvider.parse_webhook's own "not verified
    # against a live delivery" comment) -- probe the downloaded bytes
    # directly instead. mutagen is pure-Python (no ffprobe/ffmpeg binary),
    # consistent with this app having deliberately moved off self-hosted
    # ffmpeg infra (see project memory "Render backend decision"). Skip the
    # ledger row entirely on a probe failure rather than guess.
    try:
        duration_seconds = MP4(io.BytesIO(video_bytes)).info.length
    except Exception:
        logger.exception("failed to probe avatar video duration for generation=%s", generation.id)
        return

    metering_repository.record_event(
        user_id=generation.user_id,
        project_id=generation.project_id,
        event_type="avatar_video",
        provider=settings.avatar_provider,
        external_ref=generation.id,
        quantity=duration_seconds,
        unit="seconds",
        cost_estimate_cents=metering_pricing.avatar_cost_cents(duration_seconds),
    )


async def list_avatars() -> list[AvatarOptionResponse]:
    global _avatar_cache
    now = time.monotonic()
    if _avatar_cache is not None:
        cached_at, cached_options = _avatar_cache
        if now - cached_at < _AVATAR_CACHE_TTL_SECONDS:
            return cached_options

    try:
        options = await get_avatar_provider().list_avatars()
    except Exception as exc:
        logger.exception("failed to fetch avatar catalog")
        raise HTTPException(status_code=502, detail="Couldn't load the avatar catalog -- try again") from exc

    responses = [
        AvatarOptionResponse(
            id=o.id,
            name=o.name,
            preview_image_url=o.preview_image_url,
            gender=o.gender,
            preferred_orientation=o.preferred_orientation,
        )
        for o in options
    ]
    _avatar_cache = (now, responses)
    return responses
