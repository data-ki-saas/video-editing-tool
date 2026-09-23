import logging
import tempfile
import uuid
from io import BytesIO
from pathlib import Path

import httpx
from fastapi import HTTPException
from PIL import Image

from src.avatar_gen import repository
from src.avatar_gen.atlas_builder import (
    HEAD_RECT,
    _FACE_PROTECTED_TOP_FRACTION,
    _PANTS_COLOR,
    _SHIRT_COLOR,
    _TRIM_COLOR,
    build_atlas_png,
    build_atlas_png_from_photo,
)
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
# The fal.ai photo path is the exception: its "mouth"/"eyebrows"/"eyes"/
# "neck" pivots below are only correct for the procedurally-drawn parametric
# head, where each is guaranteed by construction to sit at a fixed fraction
# of the head crop. A real photo's own proportions/framing vary that
# fraction per avatar, so _parts_for -- not this constant directly -- is
# what actually gets stored per avatar; see its own doc comment and
# build_atlas_png_from_photo's `mouth_pivot`/`eyebrows_pivot`/`eyes_pivot`/
# `neck_pivot` return values.
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
    # frame instead of skin. pivotY=24 (not NECK_RECT's own sHeight/2=62) is
    # deliberate -- see NECK_RECT's own doc comment in
    # atlas_builder.py/placeholderAtlas.ts for the exact pivot math that
    # closes the raw-video gap between "head"'s own drawn chin and "torso"'s
    # opaque top, which the original 4/50 pivot/sHeight left wide open. This
    # fixed pivotY is only correct for the parametric path's known chin
    # buckets -- the fal.ai photo path computes its own per-avatar override
    # via `_compute_photo_neck_pivot` (atlas_builder.py), since a real
    # photo's chin position within its own head crop varies with that
    # person's face proportions, same bug class the mouth/eyebrows/eyes
    # pivots below were already fixed for.
    {"partId": "neck", "boneIndex": 1, "pivotX": 32, "pivotY": 24, "zOrder": 2},
    {"partId": "torso", "boneIndex": 1, "pivotX": 60, "pivotY": 8, "zOrder": 3},
    # "torsoTrim" -- rides the SAME bone/pivot as "torso" (see
    # atlas_builder.py's TORSO_TRIM_*_RECT doc comment for why this is a
    # separate part, not a second color fill on "torso" itself), drawn just
    # above it so the collar/button accent shows over the shirt fill.
    {"partId": "torsoTrim", "boneIndex": 1, "pivotX": 60, "pivotY": 8, "zOrder": 3.5},
    {"partId": "armL", "boneIndex": 3, "pivotX": 18, "pivotY": 4, "zOrder": 4},
    {"partId": "armR", "boneIndex": 4, "pivotX": 18, "pivotY": 4, "zOrder": 5},
    # "forearmL"/"forearmR" -- the elbow's own drawn segment, riding new
    # FOREARM_L/FOREARM_R bones (boneIndex 7/8, mirrors
    # frontend/src/lib/video/avatar/library.ts's own FOREARM_L/FOREARM_R
    # exactly -- see that file's top-of-file comment on why a real elbow
    # joint was added: a mic-holding pose needs to bend around the face, not
    # sweep a single rigid arm bone straight through it). Same TOP-center
    # pivot convention as armL/armR; zOrder just above its own upper arm.
    {"partId": "forearmL", "boneIndex": 7, "pivotX": 18, "pivotY": 4, "zOrder": 4.3},
    {"partId": "forearmR", "boneIndex": 8, "pivotX": 18, "pivotY": 4, "zOrder": 5.3},
    # "handL"/"handR" -- the rig's first real drawn hand, riding
    # HAND_L/HAND_R bones (boneIndex 9/10 -- shifted from the old 7/8 to make
    # room for FOREARM_L/FOREARM_R above; mirrors
    # frontend/src/lib/video/avatar/library.ts's own HAND_L/HAND_R exactly).
    # pivot near TOP-center, same convention armL/armR's own pivot uses.
    {"partId": "handL", "boneIndex": 9, "pivotX": 14, "pivotY": 4, "zOrder": 4.6},
    {"partId": "handR", "boneIndex": 10, "pivotX": 14, "pivotY": 4, "zOrder": 5.6},
    {"partId": "head", "boneIndex": 2, "pivotX": 70, "pivotY": 128, "zOrder": 6},
    # "eyes"/"eyebrows" -- mirrors library.ts's own biped-simple pivots
    # exactly (same shared topology/rig, so the SAME bone-local offsets place
    # them correctly regardless of which generator's atlas backs a skin).
    {"partId": "eyes", "boneIndex": 2, "pivotX": 30, "pivotY": 76, "zOrder": 7},
    {"partId": "eyebrows", "boneIndex": 2, "pivotX": 30, "pivotY": 88, "zOrder": 8},
    {"partId": "mouth", "boneIndex": 2, "pivotX": 25, "pivotY": 40, "zOrder": 9},
]
_MOUTH_SHAPES = [
    {"shapeId": "closed", "partId": "mouth"},
    {"shapeId": "open", "partId": "mouth"},
    # Mood-driven "laugh" override (frontend's MOOD_MOUTH_SHAPES) -- never
    # picked by word-driven lip-sync itself.
    {"shapeId": "laughOpen", "partId": "mouth"},
]

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
    # Gesture-driven hand pose -- mirrors library.ts's own EXPRESSION_SHAPES
    # hand entries exactly. "open" is deliberately not listed, same "base
    # rect IS the default shape" convention as eyebrows/"neutral" above.
    {"shapeId": "handLFist", "partId": "handL"},
    {"shapeId": "handLPoint", "partId": "handL"},
    {"shapeId": "handRFist", "partId": "handR"},
    {"shapeId": "handRPoint", "partId": "handR"},
]


def _parts_for(
    mouth_pivot: tuple[float, float] | None,
    eyebrows_pivot: tuple[float, float] | None = None,
    eyes_pivot: tuple[float, float] | None = None,
    neck_pivot: tuple[float, float] | None = None,
) -> list[dict]:
    """`_PARTS`, with the "mouth"/"eyebrows"/"eyes"/"neck" entries' pivots
    overridden when given (the fal.ai photo path -- see
    build_atlas_png_from_photo's own doc comment). Each left `None` (the
    parametric path, or a photo where that particular feature wasn't
    detected) keeps `_PARTS`' own fixed pivot for that part, which is already
    correct by construction for the parametric path."""
    overrides = {"mouth": mouth_pivot, "eyebrows": eyebrows_pivot, "eyes": eyes_pivot, "neck": neck_pivot}
    if not any(overrides.values()):
        return _PARTS

    def _apply(part: dict) -> dict:
        pivot = overrides.get(part["partId"])
        return {**part, "pivotX": pivot[0], "pivotY": pivot[1]} if pivot else part

    return [_apply(part) for part in _PARTS]


# Phase 7 -- mirrors frontend/src/lib/video/avatar/library.ts's own
# colorSlotsForPalette exactly: shirt/pants are each a single flat fill with
# nothing else sharing their rect (unlike the head, which also bakes in
# hair/eyes), which is what makes them safely recolorable via compile.ts's
# whole-rect source-atop tint. defaultColor MUST match _SHIRT_COLOR/
# _PANTS_COLOR above -- those are the literal colors build_atlas_png actually
# painted into this generated atlas.
def _color_slots_for(skin_tone: str) -> list[dict]:
    """Mirrors frontend/src/lib/video/avatar/library.ts's own
    colorSlotsForPalette -- shirt/pants/trim are each a fixed, non-photo-
    derived flat fill (this module always draws them as _SHIRT_COLOR/
    _PANTS_COLOR/_TRIM_COLOR regardless of which photo generated this
    avatar), but "handColor" is the one slot whose actually-drawn color
    genuinely varies per avatar (`skin_tone` is this avatar's own detected
    palette.skin_tone, not a fixed module constant) -- unlike those three,
    it can't be a static list, since `defaultColor` must equal whatever
    color was actually baked into THIS avatar's own atlas pixels."""
    return [
        {"slotId": "shirtColor", "targetPartIds": ["torso"], "defaultColor": _SHIRT_COLOR},
        {"slotId": "pantsColor", "targetPartIds": ["legL", "legR"], "defaultColor": _PANTS_COLOR, "respondsToExpressionParams": ["colorMood"]},
        # Defaults to this avatar's own detected skin tone -- a hand is
        # drawn in that same flat skin-tone fill (mirrors library.ts's own
        # handColor slot).
        {"slotId": "handColor", "targetPartIds": ["handL", "handR"], "defaultColor": skin_tone},
        # "trimColor" -- targets ONLY the "torsoTrim" overlay part (never
        # "torso" itself). Default matches _TRIM_COLOR, the fixed flat color
        # _draw_torso_trim_*'s own accent art is actually drawn with.
        {"slotId": "trimColor", "targetPartIds": ["torsoTrim"], "defaultColor": _TRIM_COLOR},
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
    # "torsoTrim" -- the SAME three garmentIds, resolved against the SEPARATE
    # "torsoTrim" overlay part (see _PARTS's own doc comment), mirrors
    # library.ts's own GARMENT_SHAPES exactly.
    {"shapeId": "polo", "partId": "torsoTrim"},
    {"shapeId": "blazer", "partId": "torsoTrim"},
    {"shapeId": "suit", "partId": "torsoTrim"},
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
) -> (
    tuple[
        bytes,
        bytes,
        dict[str, dict],
        tuple[float, float],
        tuple[float, float] | None,
        tuple[float, float] | None,
        tuple[float, float],
    ]
    | None
):
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
    spend on "we know there's a clear face", per this feature's own design.

    Returns `cartoon_bytes` as the first element alongside the usual
    build_atlas_png_from_photo result -- the caller persists it as
    `source_cartoon_key` so a LATER baking-code fix can be re-applied via
    rebake_generated_avatar without paying for another fal.ai call or asking
    the user to re-upload their photo."""
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

        return (cartoon_bytes, *build_atlas_png_from_photo(cartoon_bytes, cartoon_palette))
    except Exception:
        logger.exception("fal.ai cartoonify path failed for user=%s; falling back to parametric drawing", user_id)
        return None
    finally:
        tmp_path.unlink(missing_ok=True)
        try:
            r2_client.delete_object(temp_key)
        except Exception:
            logger.exception("failed to clean up temp cartoonify source %r", temp_key)


def _log_forehead_diagnostic(design_id: str, cartoon_bytes: bytes, palette: FacePalette) -> None:
    """TEMPORARY diagnostic -- [[project_avatar_face_top_protection_fix]]'s
    head_top_fraction fix still leaves a visible forehead transparency band on
    at least one real avatar after rebake, and pulling the cached source
    photo directly to investigate isn't possible from the dev sandbox (no
    network path to Supabase/R2 there). This piggybacks on the admin rebake
    button (which already runs on Render, with real network access) to log
    the exact numbers/pixels involved so the cause can be read straight out
    of Render logs instead. Never raises -- a diagnostic logging bug must
    never break an actual rebake. Remove once the forehead band is confirmed
    fixed for real avatars."""
    try:
        if not palette.detected or not palette.head_crop_box or not palette.background_rgb:
            logger.info("forehead-diag design=%s: not detected / missing crop box or background_rgb", design_id)
            return
        cartoon_image = Image.open(BytesIO(cartoon_bytes)).convert("RGB")
        head_crop = cartoon_image.crop(tuple(round(v) for v in palette.head_crop_box)).resize(
            (HEAD_RECT["sWidth"], HEAD_RECT["sHeight"]), Image.LANCZOS
        )
        protected_top_fraction = _FACE_PROTECTED_TOP_FRACTION
        if palette.head_top_fraction is not None:
            protected_top_fraction = min(_FACE_PROTECTED_TOP_FRACTION, palette.head_top_fraction)
        protected_top = HEAD_RECT["sHeight"] * protected_top_fraction
        # Sample a row just above the protected ellipse's own top edge -- this
        # is exactly the boundary where a real forehead/hair pixel either
        # stays opaque (inside the ellipse) or becomes subject to the
        # border-connected chroma-key (above it), so whatever's wrong shows up
        # right here first.
        sample_y = max(0, min(head_crop.height - 1, int(protected_top) - 5))
        row_colors = [head_crop.getpixel((x, sample_y)) for x in range(0, head_crop.width, 20)]
        logger.info(
            "forehead-diag design=%s: head_top_fraction=%s fixed_guess=%.3f chosen_fraction=%.3f "
            "protected_top_px=%.1f/%d background_rgb=%s row_y=%d row_colors=%s",
            design_id,
            palette.head_top_fraction,
            _FACE_PROTECTED_TOP_FRACTION,
            protected_top_fraction,
            protected_top,
            HEAD_RECT["sHeight"],
            palette.background_rgb,
            sample_y,
            row_colors,
        )
    except Exception:
        logger.exception("forehead diagnostic logging failed for design=%s (non-fatal)", design_id)


def _rebake_record(record: repository.AvatarDesignRecord) -> repository.AvatarDesignRecord:
    """Shared core of rebake_generated_avatar and scripts/rebake_avatars.py:
    re-runs build_atlas_png_from_photo against `record`'s cached
    source_cartoon_key and overwrites its atlas object + baked skin fields in
    place. Raises HTTPException on failure (caller decides what that means --
    a 4xx/5xx for the user-facing endpoint, a logged skip for the bulk
    script)."""
    if not record.source_cartoon_key:
        raise HTTPException(status_code=400, detail="This avatar has no cached source photo to rebake from")

    cartoon_bytes = r2_client.download_object(record.source_cartoon_key)
    palette = analyze_photo(cartoon_bytes)
    if not palette.detected:
        raise HTTPException(status_code=502, detail="Couldn't re-detect a face in this avatar's cached source photo")

    _log_forehead_diagnostic(record.id, cartoon_bytes, palette)

    atlas_png, part_rects, mouth_pivot, eyebrows_pivot, eyes_pivot, neck_pivot = build_atlas_png_from_photo(cartoon_bytes, palette)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tmp:
        tmp.write(atlas_png)
        tmp_path = Path(tmp.name)
    try:
        r2_client.upload_file(tmp_path, record.atlas_key, "image/png")
    except Exception as exc:
        logger.exception("avatar atlas rebake upload failed for design=%s", record.id)
        raise HTTPException(status_code=502, detail="Couldn't rebake this avatar -- try again") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    # Overwrite every baked-in-CODE field (not just atlas/parts) with today's
    # definitions -- these four are static per this module's own constants,
    # never per-user data, so re-baking is exactly the right time to backfill
    # ones a pre-existing record's skin JSON predates entirely (e.g.
    # expressionShapes, added for mood-driven eyebrows/blink -- without this,
    # a rebake regenerates correct eyeOpen/eyeClosed atlas pixels but the old
    # skin still has no expressionShapes entry granting permission to use
    # them, so blink silently never shows). Matches this function's own
    # "re-applies the current atlas-baking code ... in place" docstring.
    new_skin = {
        **record.skin,
        "atlas": {**record.skin["atlas"], "partRects": part_rects},
        "parts": _parts_for(mouth_pivot, eyebrows_pivot, eyes_pivot, neck_pivot),
        "mouthShapes": _MOUTH_SHAPES,
        "colorSlots": _color_slots_for(palette.skin_tone),
        "garmentShapes": _GARMENT_SHAPES,
        "expressionShapes": _EXPRESSION_SHAPES,
    }
    updated = repository.update_baked(record.id, record.user_id, new_skin, record.design)
    if updated is None:
        raise HTTPException(status_code=404, detail="Avatar not found")
    return updated


def rebake_all_avatars() -> dict[str, int]:
    """Admin bulk entry point -- mirrors scripts/rebake_avatars.py's own
    loop exactly (that script now just calls this and prints the result), so
    the admin /api/admin/tools/rebake-avatars endpoint and the CLI path stay
    in sync by construction rather than by two copies of the same loop.
    Unscoped by user (unlike rebake_generated_avatar) -- deliberately, this
    is the admin path meant to roll an atlas_builder.py fix out to every
    affected avatar at once."""
    records = repository.list_with_source_cartoon()
    succeeded = 0
    failed = 0
    for record in records:
        try:
            _rebake_record(record)
            succeeded += 1
        except Exception:
            logger.exception("bulk rebake failed for avatar design=%s user=%s", record.id, record.user_id)
            failed += 1
    return {"total": len(records), "succeeded": succeeded, "failed": failed}


def rebake_generated_avatar(design_id: str, user: CurrentUser) -> GeneratedAvatarDetail:
    """User-facing entry point for _rebake_record: re-applies the current
    atlas-baking code (build_atlas_png_from_photo) to this avatar's cached
    fal.ai output, in place -- same design_id/atlas_key, no fal.ai spend, no
    "please re-upload and generate a new avatar" round trip. Meant to be
    called after a baking bug fix ships (see scripts/rebake_avatars.py for
    doing this for every affected avatar at once); calling it with nothing
    actually changed in atlas_builder.py just re-produces the same atlas."""
    record = repository.get(design_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Avatar not found")
    updated = _rebake_record(record)
    return resolve_avatar_record(updated)


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
    eyebrows_pivot: tuple[float, float] | None = None
    eyes_pivot: tuple[float, float] | None = None
    neck_pivot: tuple[float, float] | None = None
    source_cartoon_key: str | None = None
    fal_result = await _cartoonify_and_crop(user_id=user.id, photo_bytes=photo_bytes, original_palette=palette) if palette.detected else None

    design_id = f"gen-{uuid.uuid4().hex}"
    atlas_key = f"avatars/{user.id}/{design_id}/atlas.png"

    if fal_result is not None:
        cartoon_bytes, atlas_png, part_rects, mouth_pivot, eyebrows_pivot, eyes_pivot, neck_pivot = fal_result
        used_fal = True
        # Best-effort: if this upload fails, generation still succeeds --
        # it just means a future baking-code fix can't rebake THIS avatar in
        # place and would need the old "generate a new one" path instead.
        candidate_source_key = f"avatars/{user.id}/{design_id}/source_cartoon.png"
        with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tmp:
            tmp.write(cartoon_bytes)
            tmp_path = Path(tmp.name)
        try:
            r2_client.upload_file(tmp_path, candidate_source_key, "image/png")
            source_cartoon_key = candidate_source_key
        except Exception:
            logger.exception("failed to persist source cartoon image for user=%s design=%s -- rebake won't be available for it", user.id, design_id)
        finally:
            tmp_path.unlink(missing_ok=True)
    else:
        atlas_png, part_rects = build_atlas_png(palette)

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
        "parts": _parts_for(mouth_pivot, eyebrows_pivot, eyes_pivot, neck_pivot),
        "mouthShapes": _MOUTH_SHAPES,
        "colorSlots": _color_slots_for(palette.skin_tone),
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
        record = repository.create(
            id=design_id,
            user_id=user.id,
            name=avatar_name,
            skin=skin,
            design=design,
            atlas_key=atlas_key,
            source_cartoon_key=source_cartoon_key,
        )
    except Exception as exc:
        logger.exception("avatar design insert failed for user=%s", user.id)
        try:
            r2_client.delete_object(atlas_key)
            if source_cartoon_key:
                r2_client.delete_object(source_cartoon_key)
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

    # Copy the cached fal.ai source too (not just the atlas), so this
    # duplicate stays rebakeable by a future atlas_builder.py fix the same
    # way its source avatar is -- see _rebake_record. Best-effort: an older
    # source avatar predating this cache, or a copy failure, just leaves the
    # duplicate in the same "no cached source" state every avatar was in
    # before rebaking existed.
    new_source_cartoon_key: str | None = None
    if record.source_cartoon_key:
        candidate_key = f"avatars/{user.id}/{new_design_id}/source_cartoon.png"
        try:
            r2_client.copy_object(record.source_cartoon_key, candidate_key)
            new_source_cartoon_key = candidate_key
        except Exception:
            logger.exception("source cartoon copy failed for user=%s design=%s -- duplicate won't be rebakeable", user.id, design_id)

    new_name = (name or "").strip() or f"{record.name} (customized)"
    new_skin = {**record.skin, "skinId": new_design_id}
    new_design = {**record.design, "designId": new_design_id, "skinId": new_design_id, "meta": {**record.design["meta"], "name": new_name}}
    if _has_any_override(overrides):
        for field in _OVERRIDE_FIELDS:
            if overrides.get(field):
                new_design[field] = overrides[field]

    try:
        new_record = repository.create(
            id=new_design_id,
            user_id=user.id,
            name=new_name,
            skin=new_skin,
            design=new_design,
            atlas_key=new_atlas_key,
            source_cartoon_key=new_source_cartoon_key,
        )
    except Exception as exc:
        logger.exception("avatar design duplicate insert failed for user=%s design=%s", user.id, design_id)
        try:
            r2_client.delete_object(new_atlas_key)
            if new_source_cartoon_key:
                r2_client.delete_object(new_source_cartoon_key)
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
        if record.source_cartoon_key:
            r2_client.delete_object(record.source_cartoon_key)
    except Exception:
        logger.exception("failed to delete R2 object %r for deleted avatar %s", record.atlas_key, design_id)
