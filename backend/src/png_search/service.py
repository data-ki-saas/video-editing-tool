import html
import io
import logging
import re

import httpx
from fastapi import HTTPException
from PIL import Image

from src.assets import repository as assets_repository
from src.assets.schemas import AssetInfo
from src.assets.service import store_asset_bytes
from src.core.auth import CurrentUser
from src.metering import repository as metering_repository
from src.png_search.schemas import PngSearchResponse, PngSearchResult

logger = logging.getLogger(__name__)

# Transparent cut-outs come from Wikimedia Commons (open licences, a real API,
# no scraping). Commons has no "has transparency" filter, but appending
# "png transparent" to the query surfaces mostly-transparent files, and every
# import re-checks the real alpha channel below, so an opaque one never lands
# on the timeline. (CleanPNG was tried first: it only exposes white-background
# previews publicly and gates the real PNG behind a bot challenge.)
_API_URL = "https://commons.wikimedia.org/w/api.php"
# Wikimedia's policy requires a descriptive User-Agent; generic ones get 403.
_USER_AGENT = "ReelStudio/1.0 (reel generator; aprateek@smart-structures.com) httpx"
_PAGE_SIZE = 30
_THUMB_WIDTH = 320
_IMPORT_MAX_WIDTH = 1024
_MAX_IMAGE_BYTES = 12 * 1024 * 1024
# A file counts as transparent if some pixel is clearly see-through.
_TRANSPARENT_ALPHA_BELOW = 200
_TAGS_RE = re.compile(r"<[^>]+>")


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=30, headers={"User-Agent": _USER_AGENT})


def _plain(value: str | None) -> str:
    return html.unescape(_TAGS_RE.sub("", value or "")).strip()


async def _query(client: httpx.AsyncClient, params: dict) -> dict:
    response = await client.get(_API_URL, params={"action": "query", "format": "json", **params})
    response.raise_for_status()
    return response.json()


def _to_result(page: dict) -> PngSearchResult | None:
    info = (page.get("imageinfo") or [None])[0]
    if not info or info.get("mime") != "image/png" or not info.get("thumburl"):
        return None
    meta = info.get("extmetadata") or {}
    license_name = _plain((meta.get("LicenseShortName") or {}).get("value")) or "See source"
    artist = _plain((meta.get("Artist") or {}).get("value")) or "Unknown author"
    title = re.sub(r"\.png$", "", page["title"].removeprefix("File:"), flags=re.IGNORECASE).replace("_", " ")
    return PngSearchResult(
        id=page["title"],
        title=title,
        thumbnail_url=info["thumburl"],
        width=info.get("width"),
        height=info.get("height"),
        license=license_name,
        attribution=f'"{title}" by {artist} ({license_name}) via Wikimedia Commons',
        page_url=info.get("descriptionurl", ""),
    )


async def search_png(query: str, page: int) -> PngSearchResponse:
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="A search query is required")
    page = max(1, min(page, 20))
    try:
        async with _client() as client:
            data = await _query(
                client,
                {
                    "generator": "search",
                    "gsrsearch": f"{query} png transparent",
                    "gsrnamespace": 6,
                    "gsrlimit": _PAGE_SIZE,
                    "gsroffset": (page - 1) * _PAGE_SIZE,
                    "prop": "imageinfo",
                    "iiprop": "url|mime|size|extmetadata",
                    "iiurlwidth": _THUMB_WIDTH,
                    "iiextmetadatafilter": "LicenseShortName|Artist",
                },
            )
    except httpx.HTTPError as exc:
        logger.exception("png search failed: query=%r page=%s", query, page)
        raise HTTPException(status_code=502, detail="PNG search failed") from exc

    pages = sorted((data.get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 0))
    results = [result for result in (_to_result(p) for p in pages) if result]
    return PngSearchResponse(results=results, page=page, has_more="continue" in data)


async def import_png(project_id: str, source_id: str, title: str, user: CurrentUser) -> AssetInfo:
    if not assets_repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")
    if not source_id.startswith("File:"):
        raise HTTPException(status_code=400, detail="Not a valid image id")

    # Re-resolve the download URL from Commons by title -- never fetch a URL
    # the client sent.
    try:
        async with _client() as client:
            data = await _query(
                client,
                {"titles": source_id, "prop": "imageinfo", "iiprop": "url|mime|size", "iiurlwidth": _IMPORT_MAX_WIDTH},
            )
            pages = list((data.get("query") or {}).get("pages", {}).values())
            info = (pages[0].get("imageinfo") or [None])[0] if pages else None
            if not info or info.get("mime") != "image/png":
                raise HTTPException(status_code=404, detail="That image is no longer available")
            # Commons' pre-sized thumbnail keeps PNG transparency and avoids moving
            # a multi-MB original that would be drawn at a fraction of the frame.
            download_url = info["thumburl"] if (info.get("width") or 0) > _IMPORT_MAX_WIDTH else info["url"]
            response = await client.get(download_url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.exception("png import failed: source_id=%s", source_id)
        raise HTTPException(status_code=502, detail="Failed to download the image") from exc
    if len(response.content) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="That image is too large")

    try:
        with Image.open(io.BytesIO(response.content)) as image:
            rgba = image.convert("RGBA")
    except Exception as exc:
        logger.exception("png decode failed: source_id=%s", source_id)
        raise HTTPException(status_code=502, detail="That image could not be read") from exc
    if rgba.getchannel("A").getextrema()[0] >= _TRANSPARENT_ALPHA_BELOW:
        raise HTTPException(status_code=422, detail="That image has a solid background, not a transparent one. Try another.")

    out = io.BytesIO()
    rgba.save(out, format="PNG", optimize=True)
    safe_title = re.sub(r"[^a-zA-Z0-9]+", "-", title).strip("-")[:60] or "png"
    asset = store_asset_bytes(
        project_id=project_id,
        user=user,
        filename=f"{safe_title}.png",
        content_type="image/png",
        kind="image",
        body=out.getvalue(),
    )
    metering_repository.record_consumption(
        user_id=user.id, project_id=project_id, event_type="stock_import", quantity=1, unit="items", external_ref=asset.id
    )
    return asset
