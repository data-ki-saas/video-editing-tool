import asyncio
import io
import json
import logging
import tempfile
import uuid
from pathlib import Path

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
from src.storage import quota, r2_client
from src.usage import limits

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

    # Everything that can fail for a reason unrelated to the user is checked
    # BEFORE reserving, so a misconfigured server never burns their daily slot.
    if source_asset.kind == "video":
        if not settings.backend_public_url or not settings.fal_webhook_secret:
            raise HTTPException(status_code=500, detail="Background removal isn't configured on this server yet")
    elif not settings.fal_api_key:
        raise HTTPException(status_code=500, detail="Background removal isn't configured on this server yet")

    quota.assert_can_store(user, adding_bytes=0)

    # VEED bills per output second, so the clip's real length -- measured
    # here from the stored file itself, never taken from the client -- is what
    # bounds this job's cost. One 500 MB upload of a long video would
    # otherwise be a single request billing tens of dollars.
    if source_asset.kind == "video":
        duration_seconds = await _probe_source_duration_seconds(source_asset)
        if duration_seconds > settings.matting_max_source_seconds:
            raise HTTPException(
                status_code=400,
                detail=f"Background removal is limited to clips of {settings.matting_max_source_seconds} seconds or less -- trim this clip first.",
            )
        cost_cents = metering_pricing.matting_cost_cents(duration_seconds)
    else:
        cost_cents = metering_pricing.matting_image_cost_cents()

    # Atomic reserve-then-spend (see usage/limits.py): per-user cap, site-wide
    # cap and the site-wide cost budget are all claimed in one database step
    # BEFORE fal.ai is called, so parallel requests can't overshoot, and a
    # database failure refuses the job instead of letting it through unmetered.
    limits.reserve(
        user=user,
        event_type="background_removal",
        feature="background_removal",
        noun="background removals",
        user_cap=settings.matting_daily_cap,
        global_cap=settings.matting_global_daily_cap,
        cost_cents=cost_cents,
    )

    if source_asset.kind == "image":
        return await _request_image_cutout(project_id, source_asset, user)
    return await _request_video_matte(project_id, source_asset, user)


def _probe_source_duration_sync(storage_key: str) -> float:
    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp:
        tmp_path = Path(tmp.name)
    try:
        r2_client.download_to_path(storage_key, tmp_path)
        return float(MP4(str(tmp_path)).info.length)
    finally:
        tmp_path.unlink(missing_ok=True)


async def _probe_source_duration_seconds(source_asset: AssetRecord) -> float:
    """Fails CLOSED: a clip whose length can't be measured can't be priced, so
    it isn't sent to the provider."""
    try:
        return await asyncio.to_thread(_probe_source_duration_sync, source_asset.storage_key)
    except Exception as exc:
        logger.exception("could not measure source clip duration for asset=%s", source_asset.id)
        raise HTTPException(
            status_code=400, detail="Couldn't read this clip's length, so it can't be sent for background removal."
        ) from exc


async def _request_video_matte(project_id: str, source_asset: AssetRecord, user: CurrentUser) -> RequestBackgroundRemovalResponse:
    video_url = r2_client.presigned_get_url(source_asset.storage_key)

    try:
        handle = await get_matting_provider().create_matte(video_url=video_url, callback_url=_build_callback_url())
    except Exception as exc:
        logger.exception("background removal job creation failed for project=%s asset=%s", project_id, source_asset.id)
        raise HTTPException(status_code=502, detail="Couldn't start background removal -- try again") from exc

    matting_repository.create(id=handle.provider_job_id, source_asset_id=source_asset.id, user_id=user.id)

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
    # No provider job id to key this row by (there's no webhook to look one
    # up later) -- a fresh uuid is just as good, matting_repository.create's
    # `id` column has no format requirement beyond uniqueness.
    record = matting_repository.create(id=f"img-{uuid.uuid4().hex}", source_asset_id=source_asset.id, user_id=user.id)

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
            enforce_quota=False,
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

    return RequestBackgroundRemovalResponse(status="completed", matte_asset_id=asset.id, matte_url=asset.url, error=None)


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
        # recorded -- acknowledge rather than inviting a retry storm).
        logger.warning("matting webhook for unrecognized job id=%s", event.provider_job_id)
        return

    # A replayed/duplicate delivery for a job that already resolved must not
    # download, store and bill-log the result a second time.
    if record.status != "waiting":
        logger.info("matting webhook for already-%s job id=%s -- ignoring", record.status, record.id)
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
            enforce_quota=False,
        )
    except Exception:
        # Marked failed (a terminal state) rather than left "waiting" -- fal
        # retries failed webhook DELIVERIES (non-2xx), not a delivery that
        # succeeded but whose handling errored afterward, so leaving this
        # waiting would mean it never resolves.
        logger.exception("failed to store finished matte for job=%s", record.id)
        matting_repository.mark_failed(record.id, "Failed to save the finished background-removal result")
        return

    matting_repository.mark_completed(record.id, asset.id)

    estimated = False
    try:
        duration_seconds = MP4(io.BytesIO(matte_bytes)).info.length
    except Exception:
        # The job already ran and was billed -- an unprobeable result must not
        # vanish from the ledger. Record the worst case this job could have
        # cost (the per-job duration ceiling) and flag it as an estimate.
        logger.exception("failed to probe matte duration for job=%s -- recording the worst-case estimate", record.id)
        duration_seconds = float(settings.matting_max_source_seconds)
        estimated = True

    metering_repository.record_event(
        user_id=record.user_id,
        event_type="background_removal",
        provider=settings.matting_provider,
        external_ref=record.id,
        quantity=duration_seconds,
        unit="seconds",
        cost_estimate_cents=metering_pricing.matting_cost_cents(duration_seconds),
        metadata={"estimated": True} if estimated else None,
    )
