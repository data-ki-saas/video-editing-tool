"""Server-side mirror of frontend/src/lib/video/avatar/placeholderAtlas.ts --
the SAME fixed grid packing (two shelves: head+both mouth shapes, then
torso+limbs) so a generated skin's `partRects` are guaranteed to validate
against compile.ts's `biped-simple` topology and reads as one house style
alongside the hand-authored seed characters (the avatar plan doc's own
"shared house style" tenet). `palette` (from photo_analysis.py) is the only
input that varies -- every rect position/size below is identical to the TS
version, byte-for-byte the same layout math.
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageChops, ImageDraw

from src.avatar_gen.photo_analysis import FacePalette, FaceShape, HairLength

GAP = 8

HEAD_RECT = {"sx": GAP, "sy": GAP, "sWidth": 140, "sHeight": 140}
MOUTH_CLOSED_RECT = {
    "sx": HEAD_RECT["sx"] + HEAD_RECT["sWidth"] + GAP,
    "sy": GAP,
    "sWidth": 50,
    "sHeight": 28,
}
MOUTH_OPEN_RECT = {
    "sx": MOUTH_CLOSED_RECT["sx"],
    "sy": MOUTH_CLOSED_RECT["sy"] + MOUTH_CLOSED_RECT["sHeight"] + GAP,
    "sWidth": 50,
    "sHeight": 28,
}

_ROW2_Y = HEAD_RECT["sy"] + HEAD_RECT["sHeight"] + GAP
TORSO_RECT = {"sx": GAP, "sy": _ROW2_Y, "sWidth": 120, "sHeight": 140}
ARM_L_RECT = {"sx": TORSO_RECT["sx"] + TORSO_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 36, "sHeight": 130}
ARM_R_RECT = {"sx": ARM_L_RECT["sx"] + ARM_L_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 36, "sHeight": 130}
LEG_L_RECT = {"sx": ARM_R_RECT["sx"] + ARM_R_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 42, "sHeight": 150}
LEG_R_RECT = {"sx": LEG_L_RECT["sx"] + LEG_L_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 42, "sHeight": 150}

CANVAS_WIDTH = LEG_R_RECT["sx"] + LEG_R_RECT["sWidth"] + GAP
CANVAS_HEIGHT = max(TORSO_RECT["sy"] + TORSO_RECT["sHeight"], LEG_L_RECT["sy"] + LEG_L_RECT["sHeight"]) + GAP

# Kept fixed (not photo-derived) -- only skin/hair tone vary per generated
# character, same scope placeholderAtlas.ts's own PlaceholderAtlasPalette
# gives a caller (shirt/pants/mouth/eye/outline colors are its own fixed
# module constants there too).
_SHIRT_COLOR = "#3f6fb0"
_PANTS_COLOR = "#2b2b3d"
_MOUTH_COLOR = "#7a2f2f"
_EYE_COLOR = "#2a2a2a"
_OUTLINE_COLOR = (0, 0, 0, 46)  # rgba(0,0,0,0.18) baked to RGBA


def _box(rect: dict) -> tuple[float, float, float, float]:
    return rect["sx"], rect["sy"], rect["sx"] + rect["sWidth"], rect["sy"] + rect["sHeight"]


def _rounded_rect(draw: ImageDraw.ImageDraw, rect: dict, inset: float, radius: float, fill: str) -> None:
    x0, y0, x1, y1 = _box(rect)
    draw.rounded_rectangle((x0 + inset, y0 + inset, x1 - inset, y1 - inset), radius=radius, fill=fill, outline=_OUTLINE_COLOR, width=2)


# Extra (radius_x, radius_y) multipliers layered on top of the existing
# width_scale math, one outline STYLE per face_shape bucket -- "wide" is
# drawn as a rounded rectangle instead of a stretched ellipse (see
# _draw_head below) since no amount of ellipse-stretching reads as
# "square-ish jaw" the way an actual different silhouette shape does.
# face_width_scale (continuous, photo_analysis.py) still nudges within
# whichever bucket face_shape (discrete) picks -- the two signals compose.
_FACE_SHAPE_RADIUS_MULT: dict[FaceShape, tuple[float, float]] = {
    "round": (1.0, 1.0),
    "oval": (0.85, 1.08),
    "wide": (1.08, 0.96),
}

# Hair is drawn as "head silhouette MINUS a protected face-skin window", not
# as one big hair ellipse -- growing a single hair ellipse for longer
# buckets was tried first and it inevitably swallowed the center-face once
# it got big enough (no amount of clipping fixes a shape with no hole in the
# middle). The skin window is (horizontal extent, vertical half-height,
# vertical center offset) as multipliers of (radius_x, radius_y, radius_y):
# it SHRINKS for longer buckets (more of the head reads as hair, framing the
# sides more) but never disappears, so eyes/cheeks/chin stay visible at
# every bucket -- see _draw_head's hair block below for how it's subtracted.
_SKIN_WINDOW: dict[HairLength, tuple[float, float, float]] = {
    "short": (0.9, 0.85, 0.22),
    "medium": (0.68, 0.68, 0.16),
    "long": (0.5, 0.55, 0.12),
    "bald": (1.0, 1.0, 0.0),  # unused -- hair_tone is None whenever bald
}


def _head_outline_mask(image_size: tuple[int, int], face_shape: FaceShape, bbox: tuple[float, float, float, float]) -> Image.Image:
    """A 0/255 mask of the actual head silhouette just drawn -- must match
    _draw_head's own outline choice below (ellipse vs. rounded rectangle) or
    a "wide" head's hair would paste outside its squared-off corners."""
    mask = Image.new("L", image_size, 0)
    mask_draw = ImageDraw.Draw(mask)
    if face_shape == "wide":
        mask_draw.rounded_rectangle(bbox, radius=(bbox[2] - bbox[0]) * 0.22, fill=255)
    else:
        mask_draw.ellipse(bbox, fill=255)
    return mask


def _draw_head(
    image: Image.Image,
    draw: ImageDraw.ImageDraw,
    rect: dict,
    skin_tone: str,
    hair_tone: str | None,
    width_scale: float,
    face_shape: FaceShape,
    hair_length: HairLength,
) -> None:
    cx = rect["sx"] + rect["sWidth"] / 2
    cy = rect["sy"] + rect["sHeight"] / 2
    base_radius = rect["sWidth"] / 2 - 12
    shape_x_mult, shape_y_mult = _FACE_SHAPE_RADIUS_MULT[face_shape]
    # HORIZONTAL radius varies with both signals: the photo's continuous
    # face_width_scale (see FacePalette's own doc comment) AND the discrete
    # face_shape bucket's own multiplier. VERTICAL radius only follows
    # face_shape -- width_scale alone never makes the head "shorter/taller",
    # only "narrower/wider" within whichever outline style face_shape chose.
    radius_x = base_radius * width_scale * shape_x_mult
    radius_y = base_radius * shape_y_mult
    head_bbox = (cx - radius_x, cy - radius_y, cx + radius_x, cy + radius_y)

    if face_shape == "wide":
        # A soft rounded-rectangle jaw reads as genuinely more square/wide
        # than any ellipse can, however stretched -- a different outline
        # character, not just a bigger circle.
        draw.rounded_rectangle(head_bbox, radius=radius_x * 0.45, fill=skin_tone, outline=_OUTLINE_COLOR, width=2)
    else:
        draw.ellipse(head_bbox, fill=skin_tone, outline=_OUTLINE_COLOR, width=2)

    # Hair = head silhouette minus a protected face-skin window (see
    # _SKIN_WINDOW's own comment on why, not a directly-sized hair shape).
    # ImageChops.subtract on two 0/255 masks is "head AND NOT skin_window":
    # 255-255=0 inside the protected window, 255-0=255 everywhere else in
    # the head, 0-anything=0 outside the head entirely.
    if hair_tone:
        head_mask = _head_outline_mask(image.size, face_shape, head_bbox)
        skin_h, skin_v, skin_offset = _SKIN_WINDOW[hair_length]
        skin_cy = cy + radius_y * skin_offset
        skin_window_bbox = (
            cx - radius_x * skin_h,
            skin_cy - radius_y * skin_v,
            cx + radius_x * skin_h,
            skin_cy + radius_y * skin_v,
        )
        skin_window_mask = Image.new("L", image.size, 0)
        ImageDraw.Draw(skin_window_mask).ellipse(skin_window_bbox, fill=255)
        hair_mask = ImageChops.subtract(head_mask, skin_window_mask)
        hair_layer = Image.new("RGBA", image.size, hair_tone)
        image.paste(hair_layer, (0, 0), hair_mask)

    # Two simple dot eyes, baked directly into the head part, drawn LAST so
    # they always stay visible even under generous hair coverage -- same as
    # placeholderAtlas.ts, never a separately swappable part. Offset scales
    # with the head's own width so the eyes stay plausibly placed relative
    # to a narrower or wider face instead of drifting toward/past its edge.
    eye_offset_x, eye_offset_y, eye_radius = 20 * width_scale, 8, 7
    for sign in (-1, 1):
        ex, ey = cx + sign * eye_offset_x, cy - eye_offset_y
        draw.ellipse((ex - eye_radius, ey - eye_radius, ex + eye_radius, ey + eye_radius), fill=_EYE_COLOR)


def _draw_mouth_closed(draw: ImageDraw.ImageDraw, rect: dict) -> None:
    cx, cy = rect["sx"] + rect["sWidth"] / 2, rect["sy"] + rect["sHeight"] / 2
    draw.ellipse((cx - 15, cy - 3, cx + 15, cy + 3), fill=_MOUTH_COLOR)


def _draw_mouth_open(draw: ImageDraw.ImageDraw, rect: dict) -> None:
    cx, cy = rect["sx"] + rect["sWidth"] / 2, rect["sy"] + rect["sHeight"] / 2
    draw.ellipse((cx - 11, cy - 9, cx + 11, cy + 9), fill=_MOUTH_COLOR)


def build_atlas_png(palette: FacePalette) -> tuple[bytes, dict[str, dict]]:
    """Returns (png_bytes, part_rects) -- part_rects is identical across
    every call (packing is fixed layout math, not palette-dependent), keyed
    exactly like skin.ts's `AvatarSkin.atlas.partRects` expects, so the
    caller (avatar_gen/service.py) can drop it straight into a Skin document
    with no further shaping."""
    image = Image.new("RGBA", (CANVAS_WIDTH, CANVAS_HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    _draw_head(
        image,
        draw,
        HEAD_RECT,
        palette.skin_tone,
        palette.hair_tone,
        palette.face_width_scale,
        palette.face_shape,
        palette.hair_length,
    )
    _draw_mouth_closed(draw, MOUTH_CLOSED_RECT)
    _draw_mouth_open(draw, MOUTH_OPEN_RECT)
    _rounded_rect(draw, TORSO_RECT, inset=6, radius=14, fill=_SHIRT_COLOR)
    _rounded_rect(draw, ARM_L_RECT, inset=4, radius=14, fill=palette.skin_tone)
    _rounded_rect(draw, ARM_R_RECT, inset=4, radius=14, fill=palette.skin_tone)
    _rounded_rect(draw, LEG_L_RECT, inset=4, radius=17, fill=_PANTS_COLOR)
    _rounded_rect(draw, LEG_R_RECT, inset=4, radius=17, fill=_PANTS_COLOR)

    buffer = BytesIO()
    image.save(buffer, format="PNG")

    part_rects = {
        "head": HEAD_RECT,
        "mouth": MOUTH_CLOSED_RECT,
        "closed": MOUTH_CLOSED_RECT,
        "open": MOUTH_OPEN_RECT,
        "torso": TORSO_RECT,
        "armL": ARM_L_RECT,
        "armR": ARM_R_RECT,
        "legL": LEG_L_RECT,
        "legR": LEG_R_RECT,
    }
    return buffer.getvalue(), part_rects
