import logging
import tempfile
import uuid
from pathlib import Path

import httpx
from fastapi import HTTPException

from src.avatar_gen import repository
from src.avatar_gen.atlas_builder import _PANTS_COLOR, _SHIRT_COLOR, build_atlas_png, build_atlas_png_from_photo
from src.avatar_gen.cartoonify_provider import cartoonify_image
from src.avatar_gen.photo_analysis import FacePalette, analyze_photo
from src.avatar_gen.schemas import GeneratedAvatarCreateResponse, GeneratedAvatarDetail, GeneratedAvatarSummary
from src.core.auth import CurrentUser, bypasses_daily_caps
from src.core.config import settings
from src.metering import repository as metering_repository
from src.metering import service as metering_service
from src.storage import r2_client

logger = logging.getLogger(__name__)

# Every generated Skin binds to this one shared, hand-authored Topology
# (frontend/src/lib/video/avatar/library.ts's BIPED_SIMPLE_TOPOLOGY) -- this
# is the entire payoff of the plan's Topology/Skin/Design split: the
# generator's job shrinks to "emit a valid Skin + atlas + a trivial Design",
# and it automatically gets every action the shared topology supports
# (walk/sit/sleep/lookAround/...) for free, with no per-character animation
# work here.
_TOPOLOGY_ID = "biped-simple"
_DEFAULT_NAME = "My Avatar"

# Mirrors library.ts's PLACEHOLDER_SKIN_PARTS / MOUTH_SHAPES exactly -- every
# skin bound to biped-simple must carry this identical bone-index/pivot/
# zOrder layout, since that's what compile.ts validates against and what
# actually lines up with the topology's DEFAULT_LOCAL_POSE (see library.ts's
# own doc comment on why the two are authored together). Structural, not
# palette-dependent -- a generated skin no more needs its own layout than a
# hand-drawn recolor does.
_PARTS = [
    {"partId": "legL", "boneIndex": 5, "pivotX": 21, "pivotY": 4, "zOrder": 0},
    {"partId": "legR", "boneIndex": 6, "pivotX": 21, "pivotY": 4, "zOrder": 1},
    {"partId": "torso", "boneIndex": 1, "pivotX": 60, "pivotY": 8, "zOrder": 2},
    {"partId": "armL", "boneIndex": 3, "pivotX": 18, "pivotY": 4, "zOrder": 3},
    {"partId": "armR", "boneIndex": 4, "pivotX": 18, "pivotY": 4, "zOrder": 4},
    {"partId": "head", "boneIndex": 2, "pivotX": 70, "pivotY": 128, "zOrder": 5},
    {"partId": "mouth", "boneIndex": 2, "pivotX": 25, "pivotY": 40, "zOrder": 6},
]
_MOUTH_SHAPES = [{"shapeId": "closed", "partId": "mouth"}, {"shapeId": "open", "partId": "mouth"}]

# Phase 7 -- mirrors frontend/src/lib/video/avatar/library.ts's own
# colorSlotsForPalette exactly: shirt/pants are each a single flat fill with
# nothing else sharing their rect (unlike the head, which also bakes in
# hair/eyes), which is what makes them safely recolorable via compile.ts's
# whole-rect source-atop tint. defaultColor MUST match _SHIRT_COLOR/
# _PANTS_COLOR above -- those are the literal colors build_atlas_png actually
# painted into this generated atlas.
_COLOR_SLOTS = [
    {"slotId": "shirtColor", "targetPartIds": ["torso"], "defaultColor": _SHIRT_COLOR},
    {"slotId": "pantsColor", "targetPartIds": ["legL", "legR"], "defaultColor": _PANTS_COLOR, "respondsToExpressionParams": ["colorMood"]},
]

# Phase 8 ("selectable torsos") -- mirrors frontend/src/lib/video/avatar/
# library.ts's own GARMENT_SHAPES exactly. "plainShirt" (the base "torso"
# rect) is deliberately not listed here -- a Design with no `garmentId` (or
# one this skin doesn't define) already falls back to it, same convention
# _MOUTH_SHAPES doesn't need a "no override" entry for either.
_GARMENT_SHAPES = [
    {"shapeId": "polo", "partId": "torso"},
    {"shapeId": "blazer", "partId": "torso"},
    {"shapeId": "suit", "partId": "torso"},
]

_ALLOWED_PHOTO_TYPES = {"image/jpeg", "image/png"}


def _resolve(record: repository.AvatarDesignRecord) -> GeneratedAvatarDetail:
    """Swaps a fresh presigned R2 URL into the stored Skin/Design's
    `atlas.imageRef`/`meta.thumbnail` placeholders -- never the other way
    around. The DB row itself never holds a resolved URL (those expire), only
    `atlas_key`; same "resolve fresh at read time" posture as
    frontend/src/lib/timeline/resolve.ts's own `_appMeta[id].assetId`
    pattern, just enforced on the backend since this table (unlike a
    project's timeline) is never round-tripped back through the frontend for
    saving."""
    url = r2_client.presigned_get_url(record.atlas_key)
    skin = {**record.skin, "atlas": {**record.skin["atlas"], "imageRef": url}}
    design = {**record.design, "meta": {**record.design["meta"], "thumbnail": url}}
    return GeneratedAvatarDetail(id=record.id, name=record.name, skin=skin, design=design, created_at=record.created_at)


async def _cartoonify_and_crop(*, user_id: str, photo_bytes: bytes, original_palette: FacePalette) -> tuple[bytes, dict[str, dict]] | None:
    """The fal.ai path: stage the real photo in R2 (fal needs a fetchable
    URL, not raw bytes -- same reason matting/service.py presigns a URL
    before calling fal's rembg), cartoonify it, then re-run face analysis on
    the CARTOONIFIED result (not the original) since the crop boxes must be
    in that image's own pixel coordinates. Returns None on ANY failure so the
    caller falls back to the free parametric-drawing path rather than
    failing the whole generation over a flaky external call -- same
    posture every other optional integration in this codebase takes.
    Only ever called after `original_palette.detected` is already True
    (see generate_avatar_from_photo) -- this is what gates the real fal.ai
    spend on "we know there's a clear face", per this feature's own design."""
    temp_key = f"avatars-tmp/{user_id}/{uuid.uuid4().hex}.jpg"
    with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
        tmp.write(photo_bytes)
        tmp_path = Path(tmp.name)
    try:
        r2_client.upload_file(tmp_path, temp_key, "image/jpeg")
        source_url = r2_client.presigned_get_url(temp_key)

        cartoon_url = await cartoonify_image(image_url=source_url)
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(cartoon_url)
        response.raise_for_status()
        cartoon_bytes = response.content

        cartoon_palette = analyze_photo(cartoon_bytes)
        if not cartoon_palette.detected:
            logger.warning("fal.ai cartoonify output had no detectable face for user=%s; falling back", user_id)
            return None

        return build_atlas_png_from_photo(cartoon_bytes, cartoon_palette)
    except Exception:
        logger.exception("fal.ai cartoonify path failed for user=%s; falling back to parametric drawing", user_id)
        return None
    finally:
        tmp_path.unlink(missing_ok=True)
        try:
            r2_client.delete_object(temp_key)
        except Exception:
            logger.exception("failed to clean up temp cartoonify source %r", temp_key)


async def generate_avatar_from_photo(*, user: CurrentUser, name: str | None, file_content_type: str | None, photo_bytes: bytes) -> GeneratedAvatarCreateResponse:
    if file_content_type not in _ALLOWED_PHOTO_TYPES:
        raise HTTPException(status_code=400, detail="Only .jpg/.png photos are supported")
    if not photo_bytes:
        raise HTTPException(status_code=400, detail="Photo is empty")
    if len(photo_bytes) > settings.max_upload_size_bytes:
        raise HTTPException(status_code=413, detail=f"Photo exceeds the {settings.max_upload_size_mb} MB upload limit")

    # Admin accounts skip the guardrail entirely -- see core/auth.py's
    # bypasses_daily_caps. Fails OPEN on a usage_events read error, same
    # precedent as matting/service.py's own cap check -- generation here
    # costs no external vendor money, so this is purely an abuse guard, not a
    # budget guard, and can afford to be lenient on a read failure.
    if not bypasses_daily_caps(user):
        recent = repository.count_recent_generate_events(user.id)
        if recent is not None and recent >= settings.avatar_generate_daily_cap:
            metering_service.record_cap_hit(
                user_id=user.id,
                feature="avatar_generate",
                cap_value=settings.avatar_generate_daily_cap,
                count_at_trigger=recent + 1,
            )
            raise HTTPException(
                status_code=429,
                detail=f"You've reached the limit of {settings.avatar_generate_daily_cap} avatar generations per day. Try again tomorrow.",
            )

    palette = analyze_photo(photo_bytes)

    # Only spend on fal.ai once we already know there's a clear face -- a
    # photo with none would just waste the call. detected=False keeps the
    # existing free, zero-cost parametric-drawing fallback exactly as before.
    used_fal = False
    fal_result = await _cartoonify_and_crop(user_id=user.id, photo_bytes=photo_bytes, original_palette=palette) if palette.detected else None
    if fal_result is not None:
        atlas_png, part_rects = fal_result
        used_fal = True
    else:
        atlas_png, part_rects = build_atlas_png(palette)

    design_id = f"gen-{uuid.uuid4().hex}"
    atlas_key = f"avatars/{user.id}/{design_id}/atlas.png"

    with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tmp:
        tmp.write(atlas_png)
        tmp_path = Path(tmp.name)
    try:
        r2_client.upload_file(tmp_path, atlas_key, "image/png")
    except Exception as exc:
        logger.exception("avatar atlas upload failed for user=%s", user.id)
        raise HTTPException(status_code=502, detail="Couldn't save the generated avatar -- try again") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    avatar_name = (name or "").strip() or _DEFAULT_NAME
    # `imageRef`/`thumbnail` are left blank in storage -- see _resolve's own
    # doc comment for why a resolved URL is never persisted here.
    skin = {
        "schemaVersion": 1,
        "skinId": design_id,
        "topologyId": _TOPOLOGY_ID,
        "atlas": {"imageRef": "", "partRects": part_rects},
        "parts": _PARTS,
        "mouthShapes": _MOUTH_SHAPES,
        "colorSlots": _COLOR_SLOTS,
        "garmentShapes": _GARMENT_SHAPES,
    }
    design = {
        "schemaVersion": 1,
        "designId": design_id,
        "skinId": design_id,
        "meta": {"name": avatar_name, "thumbnail": ""},
    }

    try:
        record = repository.create(id=design_id, user_id=user.id, name=avatar_name, skin=skin, design=design, atlas_key=atlas_key)
    except Exception as exc:
        logger.exception("avatar design insert failed for user=%s", user.id)
        try:
            r2_client.delete_object(atlas_key)
        except Exception:
            logger.exception("failed to clean up orphaned avatar atlas %r", atlas_key)
        raise HTTPException(status_code=502, detail="Couldn't save the generated avatar -- try again") from exc

    repository.record_generate_event(user.id)
    # Real external cost when the fal.ai path actually ran (see
    # cartoonify_cost_cents_per_image's own comment); the parametric fallback
    # is still genuinely free, so cost_estimate_cents reflects which path
    # this specific generation actually took, not a flat guess either way.
    metering_repository.record_event(
        user_id=user.id,
        event_type="avatar_generate",
        provider="fal_ai" if used_fal else "local",
        quantity=1,
        unit="images",
        cost_estimate_cents=settings.cartoonify_cost_cents_per_image if used_fal else 0,
    )

    detail = _resolve(record)
    return GeneratedAvatarCreateResponse(**detail.model_dump(), face_detected=palette.detected)


def list_generated_avatars(user: CurrentUser) -> list[GeneratedAvatarSummary]:
    return [
        GeneratedAvatarSummary(
            id=record.id,
            name=record.name,
            thumbnail_url=r2_client.presigned_get_url(record.atlas_key),
            created_at=record.created_at,
        )
        for record in repository.list_for_user(user.id)
    ]


def get_generated_avatar(design_id: str, user: CurrentUser) -> GeneratedAvatarDetail:
    record = repository.get(design_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Avatar not found")
    return _resolve(record)


def rename_generated_avatar(design_id: str, user: CurrentUser, name: str) -> GeneratedAvatarDetail:
    """In-place rename (the frontend's InlineEditableText on AvatarFramingDialog's
    "My avatars" gallery card) -- patches the row's `name` column and the
    mirrored `design.meta.name` together (repository.rename), never forking a
    new record. 404s the same way get/delete do for an id that doesn't exist
    or isn't this user's."""
    trimmed = name.strip()
    if not trimmed:
        raise HTTPException(status_code=400, detail="Name can't be empty")
    record = repository.get(design_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Avatar not found")
    design = {**record.design, "meta": {**record.design["meta"], "name": trimmed}}
    renamed = repository.rename(design_id, user.id, trimmed, design)
    if renamed is None:
        raise HTTPException(status_code=404, detail="Avatar not found")
    return _resolve(renamed)


def delete_generated_avatar(design_id: str, user: CurrentUser) -> None:
    record = repository.delete(design_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Avatar not found")
    try:
        r2_client.delete_object(record.atlas_key)
    except Exception:
        logger.exception("failed to delete R2 object %r for deleted avatar %s", record.atlas_key, design_id)
