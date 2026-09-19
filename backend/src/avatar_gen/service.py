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
# palette-dependent for the parametric (build_atlas_png) path -- a generated
# skin no more needs its own layout than a hand-drawn recolor does THERE.
# The fal.ai photo path is the one exception: its "mouth" pivot below is
# only correct for the procedurally-drawn parametric head, where the mouth
# is guaranteed by construction to sit at this fixed fraction of the head
# crop. A real photo's mouth position within its own head crop varies with
# that person's proportions/framing, so _parts_for -- not this constant
# directly -- is what actually gets stored per avatar; see its own doc
# comment and build_atlas_png_from_photo's `mouth_pivot` return value.
_PARTS = [
    {"partId": "legL", "boneIndex": 5, "pivotX": 21, "pivotY": 4, "zOrder": 0},
    {"partId": "legR", "boneIndex": 6, "pivotX": 21, "pivotY": 4, "zOrder": 1},
    # "neck" -- rides the SAME bone as "torso" (boneIndex=1, same convention
    # "mouth" already uses to share HEAD's bone with "head"), drawn BEFORE
    # (lower zOrder than) "torso" on purpose: it's a plain, fully-opaque
    # skin-tone patch, so torso's own opaque shirt body (drawn after, on
    # top) hides it everywhere EXCEPT the blazer/suit garments' open-collar
    # cutout (a deliberate fully-transparent cut, see atlas_builder.py's
    # `_cut_garment_notch` doc comment) -- that cutout has nothing else
    # drawn under it, so without "neck" underneath it reveals the raw video
    # frame instead of skin. See NECK_RECT's own doc comment in
    # atlas_builder.py/placeholderAtlas.ts for the exact pivot math.
    {"partId": "neck", "boneIndex": 1, "pivotX": 32, "pivotY": 4, "zOrder": 2},
    {"partId": "torso", "boneIndex": 1, "pivotX": 60, "pivotY": 8, "zOrder": 3},
    {"partId": "armL", "boneIndex": 3, "pivotX": 18, "pivotY": 4, "zOrder": 4},
    {"partId": "armR", "boneIndex": 4, "pivotX": 18, "pivotY": 4, "zOrder": 5},
    {"partId": "head", "boneIndex": 2, "pivotX": 70, "pivotY": 128, "zOrder": 6},
    # "eyes"/"eyebrows" -- mirrors library.ts's own biped-simple pivots
    # exactly (same shared topology/rig, so the SAME bone-local offsets place
    # them correctly regardless of which generator's atlas backs a skin).
    {"partId": "eyes", "boneIndex": 2, "pivotX": 30, "pivotY": 76, "zOrder": 7},
    {"partId": "eyebrows", "boneIndex": 2, "pivotX": 30, "pivotY": 88, "zOrder": 8},
    {"partId": "mouth", "boneIndex": 2, "pivotX": 25, "pivotY": 40, "zOrder": 9},
]
_MOUTH_SHAPES = [{"shapeId": "closed", "partId": "mouth"}, {"shapeId": "open", "partId": "mouth"}]

# Mirrors library.ts's own EXPRESSION_SHAPES exactly -- "neutral"/"eyeOpen"
# are also "eyebrows"/"eyes"' own base atlas rects (atlas_builder.py's
# part_rects), so "no mood active" renders identically to "neutral" with no
# extra fallback logic, same convention MOUTH_SHAPES' own "mouth"->closed
# base rect already uses.
_EXPRESSION_SHAPES = [
    {"shapeId": "neutral", "partId": "eyebrows"},
    {"shapeId": "angry", "partId": "eyebrows"},
    {"shapeId": "happy", "partId": "eyebrows"},
    {"shapeId": "sad", "partId": "eyebrows"},
    {"shapeId": "eyeOpen", "partId": "eyes"},
    {"shapeId": "eyeClosed", "partId": "eyes"},
]


def _parts_for(mouth_pivot: tuple[float, float] | None) -> list[dict]:
    """`_PARTS`, with the "mouth" entry's pivot overridden when
    `mouth_pivot` is given (the fal.ai photo path -- see
    build_atlas_png_from_photo's own doc comment). `None` for the
    parametric path, where `_PARTS`' own fixed mouth pivot is already
    correct by construction."""
    if mouth_pivot is None:
        return _PARTS
    pivot_x, pivot_y = mouth_pivot
    return [{**part, "pivotX": pivot_x, "pivotY": pivot_y} if part["partId"] == "mouth" else part for part in _PARTS]

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


def resolve_avatar_record(record: repository.AvatarDesignRecord) -> GeneratedAvatarDetail:
    """Swaps a fresh presigned R2 URL into the stored Skin/Design's
    `atlas.imageRef`/`meta.thumbnail` placeholders -- never the other way
    around. The DB row itself never holds a resolved URL (those expire), only
    `atlas_key`; same "resolve fresh at read time" posture as
    frontend/src/lib/timeline/resolve.ts's own `_appMeta[id].assetId`
    pattern, just enforced on the backend since this table (unlike a
    project's timeline) is never round-tripped back through the frontend for
    saving. Public (not `_resolve`) because asset_library/service.py's
    import_avatar reuses it too -- importing a library avatar creates a
    brand-new avatar_designs row the exact same shape generate/duplicate do."""
    url = r2_client.presigned_get_url(record.atlas_key)
    skin = {**record.skin, "atlas": {**record.skin["atlas"], "imageRef": url}}
    design = {**record.design, "meta": {**record.design["meta"], "thumbnail": url}}
    return GeneratedAvatarDetail(id=record.id, name=record.name, skin=skin, design=design, created_at=record.created_at)


async def _cartoonify_and_crop(
    *, user_id: str, photo_bytes: bytes, original_palette: FacePalette
) -> tuple[bytes, dict[str, dict], tuple[float, float]] | None:
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
    mouth_pivot: tuple[float, float] | None = None
    fal_result = await _cartoonify_and_crop(user_id=user.id, photo_bytes=photo_bytes, original_palette=palette) if palette.detected else None
    if fal_result is not None:
        atlas_png, part_rects, mouth_pivot = fal_result
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
    # `imageRef`/`thumbnail` are left blank in storage -- see
    # resolve_avatar_record's own doc comment for why a resolved URL is
    # never persisted here.
    skin = {
        "schemaVersion": 1,
        "skinId": design_id,
        "topologyId": _TOPOLOGY_ID,
        "atlas": {"imageRef": "", "partRects": part_rects},
        "parts": _parts_for(mouth_pivot),
        "mouthShapes": _MOUTH_SHAPES,
        "colorSlots": _COLOR_SLOTS,
        "garmentShapes": _GARMENT_SHAPES,
        "expressionShapes": _EXPRESSION_SHAPES,
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

    detail = resolve_avatar_record(record)
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
    return resolve_avatar_record(record)


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
    return resolve_avatar_record(renamed)


_OVERRIDE_FIELDS = ("boneScaleOverrides", "colorSlotOverrides", "attachedAccessories", "expressionBias", "garmentId")


def _has_any_override(overrides: dict | None) -> bool:
    """Mirrors design.ts's hasAnyDesignOverride -- an overrides object with
    every field empty/absent is treated as "nothing to bake in"."""
    if not overrides:
        return False
    return any(overrides.get(field) for field in _OVERRIDE_FIELDS)


def duplicate_generated_avatar(design_id: str, user: CurrentUser, name: str | None, overrides: dict | None) -> GeneratedAvatarDetail:
    """Saves a copy of one of this user's own avatars as a brand-new library
    entry, with `overrides` (if any) baked permanently into the copy's own
    `design` row instead of only ever living on one clip's
    AvatarOverlayClip.designOverrides. This is what lets a "Customize with AI"
    edit made inside a single reel survive that reel being deleted -- without
    it, the base gen-* avatar this was customized FROM would still be safe
    (avatar_designs has no project_id at all), but the customization itself
    was never persisted anywhere but that one project's timeline.

    Always creates a NEW row/atlas object rather than mutating the source in
    place: the same avatarId can be used, with different overrides, by clips
    in several different projects, so baking overrides into the shared record
    would leak one clip's customization into every other clip riding the same
    base avatar."""
    record = repository.get(design_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Avatar not found")

    new_design_id = f"gen-{uuid.uuid4().hex}"
    new_atlas_key = f"avatars/{user.id}/{new_design_id}/atlas.png"
    try:
        r2_client.copy_object(record.atlas_key, new_atlas_key)
    except Exception as exc:
        logger.exception("avatar atlas copy failed for user=%s design=%s", user.id, design_id)
        raise HTTPException(status_code=502, detail="Couldn't save this avatar -- try again") from exc

    new_name = (name or "").strip() or f"{record.name} (customized)"
    new_skin = {**record.skin, "skinId": new_design_id}
    new_design = {**record.design, "designId": new_design_id, "skinId": new_design_id, "meta": {**record.design["meta"], "name": new_name}}
    if _has_any_override(overrides):
        for field in _OVERRIDE_FIELDS:
            if overrides.get(field):
                new_design[field] = overrides[field]

    try:
        new_record = repository.create(id=new_design_id, user_id=user.id, name=new_name, skin=new_skin, design=new_design, atlas_key=new_atlas_key)
    except Exception as exc:
        logger.exception("avatar design duplicate insert failed for user=%s design=%s", user.id, design_id)
        try:
            r2_client.delete_object(new_atlas_key)
        except Exception:
            logger.exception("failed to clean up orphaned avatar atlas copy %r", new_atlas_key)
        raise HTTPException(status_code=502, detail="Couldn't save this avatar -- try again") from exc

    return resolve_avatar_record(new_record)


def delete_generated_avatar(design_id: str, user: CurrentUser) -> None:
    record = repository.delete(design_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Avatar not found")
    try:
        r2_client.delete_object(record.atlas_key)
    except Exception:
        logger.exception("failed to delete R2 object %r for deleted avatar %s", record.atlas_key, design_id)
