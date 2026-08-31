import io
import json
import logging
import uuid

import httpx
from fastapi import HTTPException
from mutagen.mp4 import MP4

from src.assets import repository as assets_repository
from src.assets.repository import AssetRecord
from src.assets.service import store_asset_bytes
from src.core.auth import CurrentUser
from src.core.config import settings
from src.matting import repository as matting_repository
from src.matting.client import get_matting_provider
from src.matting.schemas import BackgroundRemovalDetail, RequestBackgroundRemovalResponse
from src.metering import pricing as metering_pricing
from src.metering import repository as metering_repository
from src.storage import r2_client

logger = logging.getLogger(__name__)


def _build_callback_url() -> str:
    base = settings.backend_public_url.rstrip("/")
    return f"{base}/api/matting/webhooks/fal?secret={settings.fal_webhook_secret}"


def _resolve_matte_url(matte_asset_id: str | None, user: CurrentUser) -> str | None:
    if matte_asset_id is None:
        return None
    asset = assets_repository.get_asset(matte_asset_id, user.id)
    return r2_client.presigned_get_url(asset.storage_key) if asset else None


async def request(project_id: str, source_asset_id: str, user: CurrentUser) -> RequestBackgroundRemovalResponse:
    if not assets_repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")

    source_asset = assets_repository.get_asset(source_asset_id, user.id)
    if source_asset is None or source_asset.project_id != project_id:
        raise HTTPException(status_code=404, detail="Source asset not found in this project")
    if source_asset.kind not in ("video", "image"):
        raise HTTPException(status_code=400, detail="Background removal only applies to video clips or photos")

    # One job per SOURCE clip, not per cutaway/segment that uses it -- a clip
    # trimmed into several cutaways (or a photo reused across cutaways)
    # shares one matte/cutout instead of re-billing the provider for each
    # use (see this feature's own plan doc for why).
    existing = matting_repository.get_by_source_asset(source_asset_id, user.id)
    if existing is not None:
        return RequestBackgroundRemovalResponse(
            status=existing.status,
            matte_asset_id=existing.matte_asset_id,
            matte_url=_resolve_matte_url(existing.matte_asset_id, user),
            error=existing.error,
        )

    # Fails OPEN on a usage_events read error, same precedent as
    # avatar/service.py's own cap check -- but a miss here spends real money
    # at the provider, so matting_daily_cap should stay conservative. Shared
    # across both video and image jobs -- one budget, not two.
    recent_count = matting_repository.count_recent_matting_events(user.id)
    if recent_count is not None and recent_count >= settings.matting_daily_cap:
        raise HTTPException(
            status_code=429,
            detail=f"You've reached the limit of {settings.matting_daily_cap} background removals per day. Try again tomorrow.",
        )

    if source_asset.kind == "image":
        return await _request_image_cutout(project_id, source_asset, user)
    return await _request_video_matte(project_id, source_asset, user)


async def _request_video_matte(project_id: str, source_asset: AssetRecord, user: CurrentUser) -> RequestBackgroundRemovalResponse:
    if not settings.backend_public_url or not settings.fal_webhook_secret:
        raise HTTPException(status_code=500, detail="Background removal isn't configured on this server yet")

    video_url = r2_client.presigned_get_url(source_asset.storage_key)

    try:
        handle = await get_matting_provider().create_matte(video_url=video_url, callback_url=_build_callback_url())
    except Exception as exc:
        logger.exception("background removal job creation failed for project=%s asset=%s", project_id, source_asset.id)
        raise HTTPException(status_code=502, detail="Couldn't start background removal -- try again") from exc

    matting_repository.create(id=handle.provider_job_id, source_asset_id=source_asset.id, user_id=user.id)
    # Best-effort, same as avatar/service.py's record_avatar_event -- a
    # failure here shouldn't fail a job that was already kicked off.
    matting_repository.record_matting_event(user.id)

    return RequestBackgroundRemovalResponse(status="waiting")


async def _request_image_cutout(project_id: str, source_asset: AssetRecord, user: CurrentUser) -> RequestBackgroundRemovalResponse:
    """A photo's own background removal, unlike a video's, is synchronous --
    fal-ai/imageutils/rembg answers in a few seconds, so this awaits the
    whole thing directly rather than kicking off an async job + webhook.
    The `background_removals` row still exists (same table, same
    get_by_source_asset dedup as the video path) so a re-request for the
    same photo short-circuits via `request`'s own `existing` check above --
    it just goes straight to "completed" instead of ever visiting
    "waiting"."""
    if not settings.fal_api_key:
        raise HTTPException(status_code=500, detail="Background removal isn't configured on this server yet")

    # No provider job id to key this row by (there's no webhook to look one
    # up later) -- a fresh uuid is just as good, matting_repository.create's
    # `id` column has no format requirement beyond uniqueness.
    record = matting_repository.create(id=f"img-{uuid.uuid4().hex}", source_asset_id=source_asset.id, user_id=user.id)
    matting_repository.record_matting_event(user.id)

    image_url = r2_client.presigned_get_url(source_asset.storage_key)
    try:
        cutout_url = await get_matting_provider().create_image_cutout(image_url=image_url)
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(cutout_url)
        response.raise_for_status()
        cutout_bytes = response.content
        asset = store_asset_bytes(
            project_id=project_id,
            user=user,
            filename=f"cutout-{uuid.uuid4().hex}.png",
            content_type="image/png",
            kind="image",
            body=cutout_bytes,
        )
    except Exception as exc:
        logger.exception("image background removal failed for project=%s asset=%s", project_id, source_asset.id)
        matting_repository.mark_failed(record.id, "Couldn't remove the background from this photo -- try again")
        raise HTTPException(status_code=502, detail="Couldn't remove the background from this photo -- try again") from exc

    matting_repository.mark_completed(record.id, asset.id)
    metering_repository.record_event(
        user_id=user.id,
        project_id=project_id,
        event_type="background_removal",
        provider="fal_rembg",
        external_ref=record.id,
        quantity=1,
        unit="images",
        cost_estimate_cents=metering_pricing.matting_image_cost_cents(),
    )

    return RequestBackgroundRemovalResponse(
        status="completed", matte_asset_id=asset.id, matte_url=r2_client.presigned_get_url(asset.storage_key), error=None
    )


def get_status(source_asset_id: str, user: CurrentUser) -> BackgroundRemovalDetail:
    record = matting_repository.get_by_source_asset(source_asset_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="No background-removal job found for this asset")

    url = None
    if record.matte_asset_id is not None:
        asset = assets_repository.get_asset(record.matte_asset_id, user.id)
        url = r2_client.presigned_get_url(asset.storage_key) if asset else None

    return BackgroundRemovalDetail(status=record.status, matte_asset_id=record.matte_asset_id, matte_url=url, error=record.error)


async def handle_webhook(*, raw_body: bytes, headers: dict[str, str], query_secret: str | None) -> None:
    provider = get_matting_provider()
    if not provider.verify_webhook(raw_body=raw_body, headers=headers, query_secret=query_secret):
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    try:
        payload = json.loads(raw_body)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Request body must be valid JSON") from exc

    event = provider.parse_webhook(payload)
    if not event.provider_job_id:
        logger.error("matting webhook payload had no recognizable job id: %r", payload)
        raise HTTPException(status_code=400, detail="Unrecognized payload")

    record = matting_repository.get_by_id(event.provider_job_id)
    if record is None:
        # A stale/replayed delivery, or one for a job this app never
        # recorded -- acknowledge rather than inviting a retry storm, same
        # "no matching row" handling as the avatar/Creatomate webhooks.
        logger.warning("matting webhook for unrecognized job id=%s", event.provider_job_id)
        return

    if event.status == "failed" or not event.matte_url:
        matting_repository.mark_failed(record.id, event.error or "Background removal failed")
        return

    source_asset = assets_repository.get_asset(record.source_asset_id, record.user_id)
    if source_asset is None:
        logger.error("matting webhook for job=%s but its source asset is gone", record.id)
        matting_repository.mark_failed(record.id, "Source clip no longer exists")
        return

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(event.matte_url)
        response.raise_for_status()
        matte_bytes = response.content
        asset = store_asset_bytes(
            project_id=source_asset.project_id,
            user=CurrentUser(id=record.user_id, email=None),
            filename=f"matte-{uuid.uuid4().hex}.mp4",
            content_type="video/mp4",
            kind="video",
            body=matte_bytes,
        )
    except Exception:
        # Marked failed (a terminal state) rather than left "waiting" -- fal
        # retries failed webhook DELIVERIES (non-2xx), not a delivery that
        # succeeded but whose handling errored afterward, so leaving this
        # waiting would mean it never resolves. Same reasoning as
        # avatar/service.py's own handle_webhook.
        logger.exception("failed to store finished matte for job=%s", record.id)
        matting_repository.mark_failed(record.id, "Failed to save the finished background-removal result")
        return

    matting_repository.mark_completed(record.id, asset.id)

    try:
        duration_seconds = MP4(io.BytesIO(matte_bytes)).info.length
    except Exception:
        logger.exception("failed to probe matte duration for job=%s", record.id)
        return

    metering_repository.record_event(
        user_id=record.user_id,
        event_type="background_removal",
        provider=settings.matting_provider,
        external_ref=record.id,
        quantity=duration_seconds,
        unit="seconds",
        cost_estimate_cents=metering_pricing.matting_cost_cents(duration_seconds),
    )
