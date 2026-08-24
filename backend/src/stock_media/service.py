import logging

import httpx
from fastapi import HTTPException

from src.assets import repository as assets_repository
from src.assets.schemas import AssetInfo
from src.assets.service import store_asset_bytes
from src.core.auth import CurrentUser
from src.stock_media import freesound_client, pexels_client
from src.stock_media.schemas import StockMediaKind, StockSearchResponse, StockSearchResult

logger = logging.getLogger(__name__)

# "Limit the video size to less than a minute" -- and short background-music
# clips. Applied as a search filter for both providers (so users never even
# see a result they couldn't import), and re-checked defensively on the
# video results below since this app doesn't control what Pexels actually
# returns.
MAX_CLIP_DURATION_SECONDS = 60


def _photo_result(photo: dict) -> StockSearchResult:
    src = photo.get("src", {})
    photographer = photo.get("photographer", "unknown")
    return StockSearchResult(
        id=str(photo["id"]),
        kind="photo",
        title=photo.get("alt") or "Untitled photo",
        thumbnail_url=src.get("tiny", ""),
        preview_url=src.get("large", src.get("original", "")),
        attribution=f"Photo by {photographer} on Pexels",
        width=photo.get("width"),
        height=photo.get("height"),
    )


def _pick_video_file(files: list[dict]) -> dict | None:
    # A modest "sd" quality file is plenty for a preview player or a
    # sub-minute background clip -- no reason to move a multi-hundred-MB
    # "hd" file for either.
    return next((f for f in files if f.get("quality") == "sd"), files[0] if files else None)


def _video_result(video: dict) -> StockSearchResult:
    pictures = video.get("video_pictures") or []
    thumbnail = pictures[0]["picture"] if pictures else video.get("image", "")
    chosen = _pick_video_file(video.get("video_files") or [])
    photographer = (video.get("user") or {}).get("name", "unknown")
    return StockSearchResult(
        id=str(video["id"]),
        kind="video",
        title=f"Video by {photographer} on Pexels",
        thumbnail_url=thumbnail,
        preview_url=chosen["link"] if chosen else "",
        duration_seconds=video.get("duration"),
        attribution=f"Video by {photographer} on Pexels",
        width=video.get("width"),
        height=video.get("height"),
    )


def _music_result(sound: dict) -> StockSearchResult:
    previews = sound.get("previews") or {}
    name = sound.get("name") or "Untitled track"
    username = sound.get("username", "unknown")
    return StockSearchResult(
        id=str(sound["id"]),
        kind="music",
        title=name,
        thumbnail_url="",
        preview_url=previews.get("preview-hq-mp3") or previews.get("preview-lq-mp3") or "",
        duration_seconds=sound.get("duration"),
        attribution=f'"{name}" by {username} on Freesound (CC0)',
    )


async def search_stock_media(kind: StockMediaKind, query: str, page: int) -> StockSearchResponse:
    if not query.strip():
        raise HTTPException(status_code=400, detail="A search query is required")

    try:
        if kind == "photo":
            data = await pexels_client.search_photos(query, page)
            results = [_photo_result(photo) for photo in data.get("photos", [])]
            has_more = bool(data.get("next_page"))
        elif kind == "video":
            data = await pexels_client.search_videos(query, page, MAX_CLIP_DURATION_SECONDS)
            results = [
                _video_result(video)
                for video in data.get("videos", [])
                if (video.get("duration") or 0) <= MAX_CLIP_DURATION_SECONDS
            ]
            has_more = bool(data.get("next_page"))
        else:
            data = await freesound_client.search_music(query, page, MAX_CLIP_DURATION_SECONDS)
            results = [_music_result(sound) for sound in data.get("results", [])]
            has_more = data.get("next") is not None
    except httpx.HTTPStatusError as exc:
        logger.exception("stock media search failed: kind=%s query=%r", kind, query)
        raise HTTPException(status_code=502, detail="Stock media search failed") from exc

    return StockSearchResponse(results=results, page=page, has_more=has_more)


async def import_stock_asset(
    project_id: str, kind: StockMediaKind, source_id: str, filename: str, user: CurrentUser
) -> AssetInfo:
    if not assets_repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")

    # Re-resolves the download URL from the provider's own single-item API
    # by id, rather than trusting any URL the client might send -- this is
    # the only thing standing between "download whatever the client asks
    # for" and this endpoint, so it's not optional.
    try:
        if kind == "photo":
            photo = await pexels_client.get_photo(source_id)
            # "large2x" (Pexels' own pre-resized ~1880px-long-edge variant)
            # rather than "original" (often 4000px+, several MB) -- this
            # asset gets used as a video overlay, drawn at a fraction of an
            # output frame that itself caps at 1920px on its long edge (see
            # video_math.ts's computeOutputDimensions), so full original
            # resolution is pure storage/transfer waste. Picking a smaller
            # pre-generated Pexels variant avoids needing any image-
            # processing dependency here (this backend deliberately has
            # none -- see frontend/src/lib/image.ts's equivalent resize for
            # direct uploads, which this endpoint bypasses entirely). Falls
            # back to "original" if Pexels' response is ever missing it.
            download_url = photo["src"].get("large2x") or photo["src"]["original"]
            content_type = "image/jpeg"
            asset_kind = "image"
            extension = ".jpg"
        elif kind == "video":
            video = await pexels_client.get_video(source_id)
            chosen = _pick_video_file(video.get("video_files") or [])
            if not chosen:
                raise HTTPException(status_code=502, detail="This video has no downloadable file")
            download_url = chosen["link"]
            content_type = "video/mp4"
            asset_kind = "video"
            extension = ".mp4"
        else:
            sound = await freesound_client.get_sound(source_id)
            previews = sound.get("previews") or {}
            download_url = previews.get("preview-hq-mp3") or previews.get("preview-lq-mp3")
            if not download_url:
                raise HTTPException(status_code=502, detail="This track has no downloadable preview")
            content_type = "audio/mpeg"
            asset_kind = "audio"
            extension = ".mp3"
    except httpx.HTTPStatusError as exc:
        logger.exception("stock media lookup failed: kind=%s source_id=%s", kind, source_id)
        raise HTTPException(status_code=502, detail="Could not look up the selected item") from exc

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(download_url)
        response.raise_for_status()
    except Exception as exc:
        logger.exception("stock media download failed: kind=%s source_id=%s", kind, source_id)
        raise HTTPException(status_code=502, detail="Failed to download the selected item") from exc

    return store_asset_bytes(
        project_id=project_id,
        user=user,
        filename=f"{filename}{extension}",
        content_type=content_type,
        kind=asset_kind,
        body=response.content,
    )
