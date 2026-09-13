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

from src.avatar_gen.photo_analysis import FacePalette

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


def _draw_head(
    image: Image.Image, draw: ImageDraw.ImageDraw, rect: dict, skin_tone: str, hair_tone: str | None, width_scale: float
) -> None:
    cx = rect["sx"] + rect["sWidth"] / 2
    cy = rect["sy"] + rect["sHeight"] / 2
    base_radius = rect["sWidth"] / 2 - 12
    # Only the HORIZONTAL radius varies with the photo's measured face
    # width-scale (see FacePalette.face_width_scale's own doc comment) --
    # vertical stays fixed, so this reads as "narrower/wider face", not
    # "shorter/taller head". Clamped range keeps this well inside the
    # rect's own 12px margin (rect half-width 70, radius_x maxes out at
    # 58*1.12 =~ 65).
    radius_x = base_radius * width_scale
    radius_y = base_radius
    head_bbox = (cx - radius_x, cy - radius_y, cx + radius_x, cy + radius_y)
    draw.ellipse(head_bbox, fill=skin_tone, outline=_OUTLINE_COLOR, width=2)

    # A simple clipped "cap" over the top of the head, same as
    # placeholderAtlas.ts's own drawHead -- intersect a head-circle mask with
    # an ellipse mask (ImageChops.darker on two 0/255 masks is a plain AND),
    # then paste the hair color through that combined mask so it can never
    # spill past the head circle regardless of the ellipse's own size.
    if hair_tone:
        head_mask = Image.new("L", image.size, 0)
        ImageDraw.Draw(head_mask).ellipse(head_bbox, fill=255)
        hair_mask = Image.new("L", image.size, 0)
        hair_bbox = (
            cx - radius_x * 1.05,
            cy - radius_y * 0.35 - radius_y * 0.75,
            cx + radius_x * 1.05,
            cy - radius_y * 0.35 + radius_y * 0.75,
        )
        ImageDraw.Draw(hair_mask).ellipse(hair_bbox, fill=255)
        combined_mask = ImageChops.darker(head_mask, hair_mask)
        hair_layer = Image.new("RGBA", image.size, hair_tone)
        image.paste(hair_layer, (0, 0), combined_mask)

    # Two simple dot eyes, baked directly into the head part -- same as
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

    _draw_head(image, draw, HEAD_RECT, palette.skin_tone, palette.hair_tone, palette.face_width_scale)
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
