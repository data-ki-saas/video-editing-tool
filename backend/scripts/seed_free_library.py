"""Seeds the shared asset library (public_library_assets) with free Pixabay
artwork: placeable "props" (transparent PNGs -- car, motorcycle, cup, post box,
signboard, rocket launcher, ...) plus four black-background effect-clip
categories (fire & smoke, light & glow, weather & nature, celebration).

    uv run python scripts/seed_free_library.py --dry-run   # pick + download, upload nothing
    uv run python scripts/seed_free_library.py             # upload to R2 + insert rows

Needs PIXABAY_API_KEY plus the usual R2/Supabase credentials in backend/.env,
and migration 0046 (public_library_assets.category) applied.

Safe to re-run: ids are derived from the Pixabay id, so existing rows are
skipped. Each row's description records its Pixabay page URL and author, so
the whole seed set can be found (category + "Pixabay" in the description) and
swapped out once we sign with a provider that has proper redistribution terms.
Pixabay's Content License allows use inside an app where users pick the
asset, but not standalone redistribution of unmodified files -- this is a
stopgap, not the long-term source.
"""

import argparse
import io
import logging
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.asset_library import repository  # noqa: E402
from src.core.config import settings  # noqa: E402
from src.core.supabase_client import get_supabase_client  # noqa: E402
from src.storage import r2_client  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")
# httpx logs every request URL at INFO, and Pixabay's key is a query param.
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

ITEMS_PER_CATEGORY = 10
_PIXABAY_IMAGES = "https://pixabay.com/api/"
_PIXABAY_VIDEOS = "https://pixabay.com/api/videos/"
_MAX_PROP_EDGE = 1024
# Effect clips are composited over footage, so keep them short and light.
_MAX_CLIP_SECONDS = 15
_MAX_CLIP_BYTES = 15 * 1024 * 1024


@dataclass
class Category:
    slug: str
    kind: str  # "image" | "video"
    # More queries than ITEMS_PER_CATEGORY, so a query with no usable hit
    # doesn't leave the category short.
    queries: list[str]


CATEGORIES = [
    Category(
        "props",
        "image",
        [
            "car", "motorcycle", "coffee cup", "post box", "signboard", "rocket launcher", "gun",
            "bicycle", "traffic light", "trophy", "street lamp", "suitcase", "megaphone", "balloon",
        ],
    ),
    Category(
        "fire-smoke",
        "video",
        [
            "fire black background", "flames black background", "embers black background", "smoke black background",
            "fog black background", "explosion black background", "spark black background", "campfire black background",
            "burning black background", "steam black background", "fire overlay", "smoke overlay",
        ],
    ),
    Category(
        "light-glow",
        "video",
        [
            "light leak black background", "lens flare black background", "bokeh black background", "glitter black background",
            "sparkle black background", "glow black background", "light rays black background", "neon black background",
            "particles black background", "stars black background", "light leaks overlay", "bokeh overlay",
        ],
    ),
    Category(
        "weather-nature",
        "video",
        [
            "rain black background", "snow black background", "falling leaves black background", "dust particles black background",
            "lightning black background", "petals black background", "clouds black background", "wind black background",
            "water drops black background", "rain overlay", "snow overlay", "leaves overlay",
        ],
    ),
    Category(
        "celebration",
        "video",
        [
            "confetti black background", "fireworks black background", "balloons black background", "streamers black background",
            "party black background", "ribbons black background", "celebration black background", "hearts black background",
            "confetti overlay", "fireworks overlay", "gold confetti", "birthday overlay",
        ],
    ),
]


def _search(client: httpx.Client, url: str, query: str, **extra: str | int) -> list[dict]:
    response = client.get(
        url,
        params={"key": settings.pixabay_api_key, "q": query, "per_page": 30, "safesearch": "true", **extra},
    )
    response.raise_for_status()
    return response.json().get("hits", [])


def _download(client: httpx.Client, url: str) -> bytes:
    response = client.get(url, timeout=120, follow_redirects=True)
    response.raise_for_status()
    return response.content


def _transparent_png(raw: bytes) -> bytes | None:
    """The image re-encoded as a PNG (downscaled), or None if it isn't a real
    cut-out -- a prop sitting on an opaque background would paste a rectangle
    over the video, so require genuine transparency, with the corners clear
    and the subject not filling the whole canvas."""
    try:
        image = Image.open(io.BytesIO(raw))
    except Exception:
        return None
    if image.mode != "RGBA":
        return None
    alpha = image.getchannel("A")
    width, height = alpha.size
    if min(width, height) < 400:
        return None
    probe = alpha.resize((64, 64))
    pixels = list(probe.getdata())
    transparent_fraction = sum(1 for value in pixels if value < 20) / len(pixels)
    corners = [pixels[0], pixels[63], pixels[64 * 63], pixels[64 * 64 - 1]]
    if transparent_fraction < 0.2 or any(value > 20 for value in corners):
        return None
    if max(width, height) > _MAX_PROP_EDGE:
        scale = _MAX_PROP_EDGE / max(width, height)
        image = image.resize((round(width * scale), round(height * scale)), Image.LANCZOS)
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _is_dark_background(thumbnail: bytes) -> bool:
    """Effect clips are screen-blended over footage, so they only work on a
    near-black background -- check the frame's border brightness."""
    try:
        image = Image.open(io.BytesIO(thumbnail)).convert("L").resize((32, 18))
    except Exception:
        return False
    pixels = image.load()
    border = [pixels[x, y] for x in range(32) for y in range(18) if x in (0, 31) or y in (0, 17)]
    return sum(border) / len(border) < 30


def _title(query: str, index: int) -> str:
    base = query.replace(" black background", "").replace(" overlay", "").strip().title()
    return f"{base} {index}"


def _description(hit: dict, kind: str) -> str:
    what = "artwork" if kind == "image" else "effect clip (black background -- use a screen/lighten blend)"
    return f"Free {what} from Pixabay by {hit.get('user', 'unknown')} -- {hit.get('pageURL', '')} (Pixabay Content License)"


def _gather_props(client: httpx.Client, category: Category, seen: set[int], need: int) -> list[tuple[dict, bytes, str]]:
    picked: list[tuple[dict, bytes, str]] = []
    for query in category.queries:
        if len(picked) >= need:
            break
        for image_type in ("vector", "illustration"):
            found = False
            for hit in _search(client, _PIXABAY_IMAGES, query, image_type=image_type, order="popular"):
                if hit["id"] in seen or not hit["largeImageURL"].endswith(".png"):
                    continue
                png = _transparent_png(_download(client, hit["largeImageURL"]))
                if png is None:
                    continue
                seen.add(hit["id"])
                picked.append((hit, png, query))
                found = True
                break
            if found:
                break
    return picked


def _gather_clips(client: httpx.Client, category: Category, seen: set[int], need: int) -> list[tuple[dict, bytes, bytes, str]]:
    picked: list[tuple[dict, bytes, bytes, str]] = []
    for query in category.queries:
        if len(picked) >= need:
            break
        for hit in _search(client, _PIXABAY_VIDEOS, query, order="popular"):
            if hit["id"] in seen or hit["duration"] > _MAX_CLIP_SECONDS:
                continue
            sizes = hit["videos"]
            rendition = next(
                (sizes[name] for name in ("medium", "small", "tiny") if sizes.get(name, {}).get("url") and 0 < sizes[name]["size"] <= _MAX_CLIP_BYTES),
                None,
            )
            if rendition is None:
                continue
            thumbnail = _download(client, rendition["thumbnail"])
            if not _is_dark_background(thumbnail):
                continue
            seen.add(hit["id"])
            picked.append((hit, _download(client, rendition["url"]), thumbnail, query))
            break
    return picked


def _publish(row_id: str, category: str, asset_type: str, title: str, description: str, media: bytes, mime: str, ext: str,
             thumbnail: bytes | None, thumbnail_ext: str, duration: float | None, promoted_by: str) -> None:
    media_key = f"library-assets/seed/{category}/{row_id}{ext}"
    thumb_key = f"library-assets/seed/{category}/{row_id}-thumb{thumbnail_ext}"
    keys: list[str] = []
    try:
        media_url = _upload(media, media_key, mime, ext)
        keys.append(media_key)
        thumbnail_url = media_url
        if thumbnail is not None:
            thumbnail_url = _upload(thumbnail, thumb_key, "image/jpeg", thumbnail_ext)
            keys.append(thumb_key)
        get_supabase_client().table("public_library_assets").insert(
            {
                "id": row_id,
                "asset_type": asset_type,
                "promoted_by": promoted_by,
                "title": title,
                "description": description,
                "thumbnail_url": thumbnail_url,
                "media_url": media_url,
                "media_mime_type": mime,
                "media_duration_seconds": duration,
                "category": category,
            }
        ).execute()
    except Exception:
        for key in keys:
            try:
                r2_client.delete_public_object(key)
            except Exception:
                logger.exception("failed to clean up %s", key)
        raise


def _upload(body: bytes, key: str, mime: str, ext: str) -> str:
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
        tmp.write(body)
        path = Path(tmp.name)
    try:
        return r2_client.upload_public_object(path, key, mime)
    finally:
        path.unlink(missing_ok=True)


def _default_promoter() -> str:
    rows = get_supabase_client().table("users").select("id").limit(1).execute().data
    if not rows:
        raise SystemExit("No users found -- pass --promoted-by <user id>")
    return rows[0]["id"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="pick and download, but upload nothing")
    parser.add_argument("--promoted-by", help="users.id the seeded rows are attributed to (default: first user)")
    parser.add_argument("--only", help="seed just this category slug")
    args = parser.parse_args()

    if not settings.pixabay_api_key:
        raise SystemExit("PIXABAY_API_KEY is not set in backend/.env")

    promoted_by = None if args.dry_run else (args.promoted_by or _default_promoter())
    totals: dict[str, int] = {}
    # A Pixabay clip can match several categories' queries (glitter vs. dust
    # particles, say) and row ids come from the Pixabay id, so dedupe across
    # ALL categories -- and count what's already seeded, so a re-run only
    # tops each category up to ITEMS_PER_CATEGORY instead of adding more.
    existing = repository.list_public(None) if not args.dry_run else []
    seen: set[int] = {int(record.id.rsplit("-", 1)[1]) for record in existing if record.id.startswith("seed-pixabay-")}
    existing_count: dict[str, int] = {}
    for record in existing:
        if record.id.startswith("seed-pixabay-") and record.category:
            existing_count[record.category] = existing_count.get(record.category, 0) + 1
    with httpx.Client(timeout=30) as client:
        for category in CATEGORIES:
            if args.only and category.slug != args.only:
                continue
            need = ITEMS_PER_CATEGORY - existing_count.get(category.slug, 0)
            logger.info("== %s (need %d more)", category.slug, need)
            if need <= 0:
                continue
            if category.kind == "image":
                items = [(hit, png, None, query) for hit, png, query in _gather_props(client, category, seen, need)]
            else:
                items = _gather_clips(client, category, seen, need)
            for index, (hit, media, thumbnail, query) in enumerate(items, start=existing_count.get(category.slug, 0) + 1):
                row_id = f"seed-pixabay-{category.kind}-{hit['id']}"
                title = _title(query, 1) if category.kind == "image" else _title(query, index)
                logger.info("  %s  %s  (%s KB)", row_id, title, len(media) // 1024)
                if args.dry_run or repository.get(row_id) is not None:
                    continue
                if category.kind == "image":
                    _publish(row_id, category.slug, "image", _title(query, 1).rsplit(" ", 1)[0], _description(hit, "image"),
                             media, "image/png", ".png", None, ".jpg", None, promoted_by)
                else:
                    _publish(row_id, category.slug, "video", title, _description(hit, "video"),
                             media, "video/mp4", ".mp4", thumbnail, ".jpg", float(hit["duration"]), promoted_by)
            totals[category.slug] = existing_count.get(category.slug, 0) + len(items)
    logger.info("totals: %s", totals)
    for slug, count in totals.items():
        if count < ITEMS_PER_CATEGORY:
            logger.warning("%s: only %d of %d found -- add queries to CATEGORIES", slug, count, ITEMS_PER_CATEGORY)


if __name__ == "__main__":
    main()
