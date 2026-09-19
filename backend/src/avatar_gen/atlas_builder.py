"""Server-side mirror of frontend/src/lib/video/avatar/placeholderAtlas.ts --
the SAME fixed grid packing (two shelves: head+both mouth shapes, then
torso+limbs) so a generated skin's `partRects` are guaranteed to validate
against compile.ts's `biped-simple` topology and reads as one house style
alongside the hand-authored seed characters (the avatar plan doc's own
"shared house style" tenet). `palette` (from photo_analysis.py) is the only
input that varies -- part rect position/size is fixed layout math either way.

The head is now drawn from `palette.face_oval` -- a real per-person contour
traced from mediapipe's own landmark groups (see photo_analysis.py's module
doc comment) -- instead of a 3-bucket outline choice. The face_width_scale/
face_shape bucket fields still drive a fallback drawing whenever no contour
is available (detected=False; e.g. no face found).

Eyebrows and eyes are their OWN swappable rects (mirrors
placeholderAtlas.ts's "eyebrows"/"eyes" parts), not baked into the head --
`_draw_face_features_layer` draws real per-person eyebrow/eye contours
(`palette.left_eye`/`right_eye`/`left_eyebrow`/`right_eyebrow`, falling back
to two dots for eyes / nothing for eyebrows when undetected) onto their own
transparent layers at the same head-relative position they used to be baked
at, and `_paste_cropped_bbox` crops+relocates each into its own small rect.
Only "neutral" eyebrows and "eyeOpen" are ever real per-person art; the
angry/happy/sad/eyeClosed variants are synthesized by `_draw_mood_eyebrow`/
`_draw_closed_eye` (shared by both generators below), since neither has an
actual photo of this avatar making those expressions to draw from instead.
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat

from src.avatar_gen.photo_analysis import FacePalette, FaceShape, HairLength, Point

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

# Mirrors avatar_gen/service.py's own `_PARTS` "head"/"mouth" entries
# (pivotX/pivotY, boneIndex=HEAD for both) -- needed here too so
# `_compute_photo_mouth_pivot` below can reason about where the "mouth"
# part's rect actually lands relative to "head"'s own rect once both are
# drawn against the SAME bone, without importing service.py (which imports
# this module, not the other way around).
_HEAD_PART_PIVOT = (70, 128)

_ROW2_Y = HEAD_RECT["sy"] + HEAD_RECT["sHeight"] + GAP
TORSO_RECT = {"sx": GAP, "sy": _ROW2_Y, "sWidth": 120, "sHeight": 140}
ARM_L_RECT = {"sx": TORSO_RECT["sx"] + TORSO_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 36, "sHeight": 130}
ARM_R_RECT = {"sx": ARM_L_RECT["sx"] + ARM_L_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 36, "sHeight": 130}
LEG_L_RECT = {"sx": ARM_R_RECT["sx"] + ARM_R_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 42, "sHeight": 150}
LEG_R_RECT = {"sx": LEG_L_RECT["sx"] + LEG_L_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 42, "sHeight": 150}

# Row 3 -- mirrors frontend/src/lib/video/avatar/placeholderAtlas.ts's own
# Row 3 exactly (same rect sizes/order/extra GAP*2 clearance -- see that
# file's own comment on why these shapes' collar/lapel details need the
# extra headroom): three alternate torso silhouettes ("polo"/"blazer"/
# "suit"), each the SAME sWidth/sHeight as TORSO_RECT so a picked garment's
# rect can substitute for the "torso" part's own rect with no change to that
# part's own pivot.
_ROW3_Y = max(TORSO_RECT["sy"] + TORSO_RECT["sHeight"], LEG_L_RECT["sy"] + LEG_L_RECT["sHeight"]) + GAP * 2
POLO_RECT = {"sx": GAP, "sy": _ROW3_Y, "sWidth": 120, "sHeight": 140}
BLAZER_RECT = {"sx": POLO_RECT["sx"] + POLO_RECT["sWidth"] + GAP, "sy": _ROW3_Y, "sWidth": 120, "sHeight": 140}
SUIT_RECT = {"sx": BLAZER_RECT["sx"] + BLAZER_RECT["sWidth"] + GAP, "sy": _ROW3_Y, "sWidth": 120, "sHeight": 140}

# Row 4 -- "neck": a plain skin-tone patch riding the SAME bone as "torso"
# (boneIndex=1 in service.py's _PARTS, same convention "mouth" already uses
# to share HEAD's bone with "head"). Exists purely to sit BEHIND the
# blazer/suit garments' open-collar cutout (`_cut_garment_notch` above
# erases alpha to fully transparent on purpose, so a recolor never fills it
# back in -- see that function's own doc comment) -- without this, that cut
# has nothing opaque drawn under it, so the collar "hole" shows the raw
# video frame straight through instead of reading as an open collar.
# Sized/pivoted (service.py's "neck" pivot) so it starts just above the
# bone joint and reaches down past the suit's deepest cut (topY+44,
# cx+-26 -- see `_draw_torso_suit`); zOrder places it right after "torso"
# and before "head"/"arms", the same layer conceptually a real neck bone
# would occupy.
_ROW4_Y = SUIT_RECT["sy"] + SUIT_RECT["sHeight"] + GAP
NECK_RECT = {"sx": GAP, "sy": _ROW4_Y, "sWidth": 64, "sHeight": 50}

# A fourth/fifth column, to the right of the mouth-shape column -- mirrors
# frontend/src/lib/video/avatar/placeholderAtlas.ts's own EYEBROWS_*/EYES_*
# rects exactly (same sizes/shapeIds -- "neutral"/"angry"/"happy"/"sad" for
# eyebrows, "eyeOpen"/"eyeClosed" for eyes, distinct from "mouth"'s own
# "open"/"closed" since partRects is one flat namespace shared by every
# part's shapes). Both columns are shorter than HEAD_RECT's own height, so
# neither affects _ROW2_Y above.
_EYEBROWS_COLUMN_X = MOUTH_CLOSED_RECT["sx"] + MOUTH_CLOSED_RECT["sWidth"] + GAP
_EYEBROWS_WIDTH = 60
_EYEBROWS_HEIGHT = 16
EYEBROWS_NEUTRAL_RECT = {"sx": _EYEBROWS_COLUMN_X, "sy": GAP, "sWidth": _EYEBROWS_WIDTH, "sHeight": _EYEBROWS_HEIGHT}
EYEBROWS_ANGRY_RECT = {"sx": _EYEBROWS_COLUMN_X, "sy": EYEBROWS_NEUTRAL_RECT["sy"] + _EYEBROWS_HEIGHT + GAP, "sWidth": _EYEBROWS_WIDTH, "sHeight": _EYEBROWS_HEIGHT}
EYEBROWS_HAPPY_RECT = {"sx": _EYEBROWS_COLUMN_X, "sy": EYEBROWS_ANGRY_RECT["sy"] + _EYEBROWS_HEIGHT + GAP, "sWidth": _EYEBROWS_WIDTH, "sHeight": _EYEBROWS_HEIGHT}
EYEBROWS_SAD_RECT = {"sx": _EYEBROWS_COLUMN_X, "sy": EYEBROWS_HAPPY_RECT["sy"] + _EYEBROWS_HEIGHT + GAP, "sWidth": _EYEBROWS_WIDTH, "sHeight": _EYEBROWS_HEIGHT}

_EYES_COLUMN_X = _EYEBROWS_COLUMN_X + _EYEBROWS_WIDTH + GAP
_EYES_WIDTH = 60
_EYES_HEIGHT = 20
EYES_OPEN_RECT = {"sx": _EYES_COLUMN_X, "sy": GAP, "sWidth": _EYES_WIDTH, "sHeight": _EYES_HEIGHT}
EYES_CLOSED_RECT = {"sx": _EYES_COLUMN_X, "sy": EYES_OPEN_RECT["sy"] + _EYES_HEIGHT + GAP, "sWidth": _EYES_WIDTH, "sHeight": _EYES_HEIGHT}

CANVAS_WIDTH = max(LEG_R_RECT["sx"] + LEG_R_RECT["sWidth"], SUIT_RECT["sx"] + SUIT_RECT["sWidth"], EYES_OPEN_RECT["sx"] + EYES_OPEN_RECT["sWidth"]) + GAP
CANVAS_HEIGHT = NECK_RECT["sy"] + NECK_RECT["sHeight"] + GAP

# Kept fixed (not photo-derived) -- only skin/hair tone vary per generated
# character, same scope placeholderAtlas.ts's own PlaceholderAtlasPalette
# gives a caller (shirt/pants/mouth/eye/outline colors are its own fixed
# module constants there too).
_SHIRT_COLOR = "#3f6fb0"
_PANTS_COLOR = "#2b2b3d"
_MOUTH_COLOR = "#7a2f2f"
_TEETH_COLOR = "#f2e9df"
_EYE_COLOR = "#2a2a2a"
_DEFAULT_BROW_COLOR = "#3a2a1f"
_OUTLINE_COLOR = (0, 0, 0, 46)  # rgba(0,0,0,0.18) baked to RGBA

# Maps photo_analysis.py's normalized face-relative units (origin = hairline/
# chin midpoint, unit = hairline-to-chin distance) onto HEAD_RECT pixels.
# hairline/chin are themselves points ON face_oval (indices 10/152 are the
# mediapipe landmarks those measurements were built from), so face_oval's
# own vertical extent spans almost exactly [-0.5, +0.5] in this normalized
# space -- sizing CONTOUR_SCALE to HEAD_RECT's usable diameter (2x the same
# base_radius the legacy bucket path uses) makes every contour fill the rect
# the same way the old single ellipse did, with the same 12px margin.
_BASE_RADIUS = HEAD_RECT["sWidth"] / 2 - 12
_CONTOUR_SCALE = 2 * _BASE_RADIUS
_HEAD_CENTER = (HEAD_RECT["sx"] + HEAD_RECT["sWidth"] / 2, HEAD_RECT["sy"] + HEAD_RECT["sHeight"] / 2)


def _remap(point: Point) -> tuple[float, float]:
    nx, ny = point
    return _HEAD_CENTER[0] + nx * _CONTOUR_SCALE, _HEAD_CENTER[1] + ny * _CONTOUR_SCALE


def _remap_all(points: list[Point]) -> list[tuple[float, float]]:
    return [_remap(p) for p in points]


def _darken(hex_color: str, amount: float) -> str:
    r, g, b = int(hex_color[1:3], 16), int(hex_color[3:5], 16), int(hex_color[5:7], 16)
    r, g, b = (max(0, round(c * (1 - amount))) for c in (r, g, b))
    return f"#{r:02x}{g:02x}{b:02x}"


def _average_color(image: Image.Image, box: tuple[float, float, float, float]) -> tuple[int, int, int]:
    """Mean RGB over a region -- used to sample a real photo's own lip color
    so a synthesized mouth-gap can match that specific avatar instead of one
    fixed constant. Falls back to `_MOUTH_COLOR`'s own RGB if the box is
    degenerate (shouldn't happen against this module's fixed rect sizes, but
    cheaper to guard than to assume)."""
    region = image.convert("RGB").crop(tuple(round(v) for v in box))
    if region.width == 0 or region.height == 0:
        return (0x7A, 0x2F, 0x2F)
    r, g, b = ImageStat.Stat(region).mean[:3]
    return (round(r), round(g), round(b))


def _compute_photo_mouth_pivot(
    head_crop_box: tuple[float, float, float, float], mouth_crop_box: tuple[float, float, float, float]
) -> tuple[float, float]:
    """Where the "mouth" part's pivot needs to be so its rect lands exactly
    over THIS photo's real mouth, instead of service.py's `_PARTS`/this
    frontend mirror's fixed (25, 40) -- which assumes the mouth sits at a
    constant fraction down the head crop, true only for the procedurally-
    drawn parametric head (`build_atlas_png` above), not a real photo (a
    real face's mouth position within its own square, hair-margin-padded
    head crop varies with that person's proportions and framing).

    Derivation: renderer.ts draws a part's rect at bone-local offset
    (-pivotX, -pivotY), and both "head" and "mouth" share the SAME bone, so
    a point at rect-local (px, py) in a part's own image lands at head-image
    pixel `_HEAD_PART_PIVOT + (px - pivotX, py - pivotY)` (since "head"'s
    own rect is drawn at bone-local offset -_HEAD_PART_PIVOT, i.e. head-image
    pixel 0 IS bone-local -_HEAD_PART_PIVOT). Solving for the pivot that puts
    the mouth rect's CENTER at the real mouth's fractional position
    (fracX, fracY) within the head crop:
        pivot = _HEAD_PART_PIVOT + (rectSize / 2) - frac * HEAD_RECT_size
    """
    hx0, hy0, hx1, hy1 = head_crop_box
    mx0, my0, mx1, my1 = mouth_crop_box
    frac_x = ((mx0 + mx1) / 2 - hx0) / max(1.0, hx1 - hx0)
    frac_y = ((my0 + my1) / 2 - hy0) / max(1.0, hy1 - hy0)
    pivot_x = _HEAD_PART_PIVOT[0] + MOUTH_CLOSED_RECT["sWidth"] / 2 - frac_x * HEAD_RECT["sWidth"]
    pivot_y = _HEAD_PART_PIVOT[1] + MOUTH_CLOSED_RECT["sHeight"] / 2 - frac_y * HEAD_RECT["sHeight"]
    return pivot_x, pivot_y


def _box(rect: dict) -> tuple[float, float, float, float]:
    return rect["sx"], rect["sy"], rect["sx"] + rect["sWidth"], rect["sy"] + rect["sHeight"]


def _rounded_rect(draw: ImageDraw.ImageDraw, rect: dict, inset: float, radius: float, fill: str) -> None:
    x0, y0, x1, y1 = _box(rect)
    draw.rounded_rectangle((x0 + inset, y0 + inset, x1 - inset, y1 - inset), radius=radius, fill=fill, outline=_OUTLINE_COLOR, width=2)


def _torso_body(draw: ImageDraw.ImageDraw, rect: dict) -> None:
    """The plain rounded-rect torso body every garment variant below starts
    from -- exactly what TORSO_RECT ("plain shirt") has always drawn, mirrors
    placeholderAtlas.ts's own drawTorsoBody."""
    _rounded_rect(draw, rect, inset=6, radius=14, fill=_SHIRT_COLOR)


def _draw_neck(draw: ImageDraw.ImageDraw, rect: dict, skin_tone: str) -> None:
    """Plain skin-tone patch for the "neck" part -- see NECK_RECT's own doc
    comment above for why this exists (backing the blazer/suit collar
    cutout). Mirrors placeholderAtlas.ts's drawNeck."""
    _rounded_rect(draw, rect, inset=4, radius=10, fill=skin_tone)


def _fill_garment_triangle(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]]) -> None:
    """Fills+outlines one triangle in the shirt's own color -- ADDS to the
    plain body's silhouette (a polo collar point, a suit lapel wedge).
    Deliberately always `_SHIRT_COLOR`, never a second contrasting color: a
    generated Design's colorSlotOverrides recolor (compile.ts's
    recolorAtlas, frontend) re-tints a WHOLE target rect uniformly wherever
    it isn't fully transparent, so only a SILHOUETTE difference survives
    that recolor -- see placeholderAtlas.ts's own fillGarmentTriangle doc
    comment for the full reasoning, mirrored here exactly."""
    draw.polygon(points, fill=_SHIRT_COLOR)
    draw.line([*points, points[0]], fill=_OUTLINE_COLOR, width=2, joint="curve")


def _cut_garment_notch(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]]) -> None:
    """Cuts a triangular, fully-transparent notch out of whatever's already
    drawn -- PIL's ImageDraw sets raw RGBA pixel values rather than
    alpha-compositing, so `fill=(0, 0, 0, 0)` genuinely erases alpha here
    (the same effect as placeholderAtlas.ts's `destination-out` composite),
    and survives a colorSlotOverrides recolor exactly as drawn: an open
    collar stays open no matter what shirt color is picked. A thin outline
    traced back afterward gives the cut a visible edge instead of a bare
    hard-alpha cliff."""
    draw.polygon(points, fill=(0, 0, 0, 0))
    draw.line(points, fill=_OUTLINE_COLOR, width=2, joint="curve")


def _draw_torso_polo(draw: ImageDraw.ImageDraw, rect: dict) -> None:
    """Plain shirt body plus two small collar-point triangles poking up from
    the neckline -- mirrors placeholderAtlas.ts's drawTorsoPolo."""
    _torso_body(draw, rect)
    cx = rect["sx"] + rect["sWidth"] / 2
    top_y = rect["sy"] + 6
    _fill_garment_triangle(draw, [(cx - 30, top_y), (cx - 10, top_y - 12), (cx - 6, top_y)])
    _fill_garment_triangle(draw, [(cx + 30, top_y), (cx + 10, top_y - 12), (cx + 6, top_y)])


def _draw_torso_blazer(draw: ImageDraw.ImageDraw, rect: dict) -> None:
    """Plain shirt body with an open, V-shaped collar notch cut into the
    top-center -- mirrors placeholderAtlas.ts's drawTorsoBlazer."""
    _torso_body(draw, rect)
    cx = rect["sx"] + rect["sWidth"] / 2
    top_y = rect["sy"] + 6
    _cut_garment_notch(draw, [(cx - 20, top_y), (cx, top_y + 30), (cx + 20, top_y)])


def _draw_torso_suit(draw: ImageDraw.ImageDraw, rect: dict) -> None:
    """Blazer's open collar notch, cut deeper, plus two small peaked-lapel
    triangles added at the shoulders -- mirrors placeholderAtlas.ts's
    drawTorsoSuit."""
    _torso_body(draw, rect)
    cx = rect["sx"] + rect["sWidth"] / 2
    top_y = rect["sy"] + 6
    _fill_garment_triangle(draw, [(rect["sx"] + 8, top_y + 18), (rect["sx"] + 8, top_y - 6), (cx - 16, top_y)])
    _fill_garment_triangle(
        draw, [(rect["sx"] + rect["sWidth"] - 8, top_y + 18), (rect["sx"] + rect["sWidth"] - 8, top_y - 6), (cx + 16, top_y)]
    )
    _cut_garment_notch(draw, [(cx - 26, top_y), (cx, top_y + 44), (cx + 26, top_y)])


# Fallback-only (no face_oval contour available, e.g. detected=False): the
# original 3-bucket outline approach. Extra (radius_x, radius_y) multipliers
# on top of the legacy width_scale math -- "wide" draws a rounded rectangle
# instead of a stretched ellipse, since no amount of ellipse-stretching
# reads as "square-ish jaw" the way an actually different silhouette does.
_FACE_SHAPE_RADIUS_MULT: dict[FaceShape, tuple[float, float]] = {
    "round": (1.0, 1.0),
    "oval": (0.85, 1.08),
    "wide": (1.08, 0.96),
}

# Hair is drawn as "head silhouette MINUS a protected face-skin window", not
# as one big hair shape -- growing a single hair ellipse for longer buckets
# was tried first and it inevitably swallowed the center-face once it got
# big enough (no amount of clipping fixes a shape with no hole in the
# middle). (horizontal extent, vertical half-height, vertical center offset)
# as multipliers of (radius_x, radius_y, radius_y): the window SHRINKS for
# longer buckets (more of the head reads as hair, framing the sides more)
# but never disappears, so eyes/brows/chin stay visible at every bucket.
_SKIN_WINDOW: dict[HairLength, tuple[float, float, float]] = {
    "short": (0.9, 0.85, 0.22),
    "medium": (0.68, 0.68, 0.16),
    "long": (0.5, 0.55, 0.12),
    "bald": (1.0, 1.0, 0.0),  # unused -- hair_tone is None whenever bald
}


def _legacy_head_bbox(rect: dict, width_scale: float, face_shape: FaceShape) -> tuple[float, float, float, float]:
    cx, cy = _HEAD_CENTER
    shape_x_mult, shape_y_mult = _FACE_SHAPE_RADIUS_MULT[face_shape]
    radius_x = _BASE_RADIUS * width_scale * shape_x_mult
    radius_y = _BASE_RADIUS * shape_y_mult
    return cx - radius_x, cy - radius_y, cx + radius_x, cy + radius_y


def _head_outline_mask(image_size: tuple[int, int], face_oval: list[Point], fallback_bbox: tuple, fallback_shape: FaceShape) -> Image.Image:
    """A 0/255 mask of the actual head silhouette -- the real face_oval
    polygon when available, otherwise the same ellipse/rounded-rect the
    outline itself fell back to (must always match _draw_head's own outline
    choice, or hair would paste outside it)."""
    mask = Image.new("L", image_size, 0)
    mask_draw = ImageDraw.Draw(mask)
    if face_oval:
        mask_draw.polygon(_remap_all(face_oval), fill=255)
    elif fallback_shape == "wide":
        mask_draw.rounded_rectangle(fallback_bbox, radius=(fallback_bbox[2] - fallback_bbox[0]) * 0.22, fill=255)
    else:
        mask_draw.ellipse(fallback_bbox, fill=255)
    return mask


def _draw_eye(draw: ImageDraw.ImageDraw, points: list[Point]) -> None:
    draw.polygon(_remap_all(points), fill=_EYE_COLOR)


def _draw_eyebrow(draw: ImageDraw.ImageDraw, points: list[Point], color: str) -> None:
    pixel_points = _remap_all(points)
    if len(pixel_points) < 2:
        return
    draw.line(pixel_points, fill=color, width=4, joint="curve")
    # Round caps -- draw.line's joints round inner corners but not the two
    # open ends, which otherwise look like a chopped-off stroke.
    radius = 2
    for x, y in (pixel_points[0], pixel_points[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)


def _draw_nose(draw: ImageDraw.ImageDraw, center: Point, width_scale: float, skin_tone: str) -> None:
    cx, cy = _remap(center)
    half_w = 6 * width_scale
    shade = _darken(skin_tone, 0.18)
    # A small soft wedge, not a full outline -- cartoon noses read better as
    # a subtle shading hint than a hard-edged shape at this size/style.
    draw.line([(cx - half_w * 0.3, cy - half_w * 1.4), (cx - half_w * 0.5, cy + half_w * 0.6)], fill=shade, width=2)
    draw.arc((cx - half_w, cy + half_w * 0.2, cx + half_w, cy + half_w * 1.4), start=20, end=160, fill=shade, width=2)


def _draw_head(
    image: Image.Image,
    draw: ImageDraw.ImageDraw,
    skin_tone: str,
    hair_tone: str | None,
    width_scale: float,
    face_shape: FaceShape,
    hair_length: HairLength,
    face_oval: list[Point],
    nose_center: Point,
    nose_width_scale: float,
) -> None:
    fallback_bbox = _legacy_head_bbox(HEAD_RECT, width_scale, face_shape)

    if face_oval:
        draw.polygon(_remap_all(face_oval), fill=skin_tone, outline=_OUTLINE_COLOR, width=2)
    elif face_shape == "wide":
        radius_x = fallback_bbox[2] - _HEAD_CENTER[0]
        draw.rounded_rectangle(fallback_bbox, radius=radius_x * 0.45, fill=skin_tone, outline=_OUTLINE_COLOR, width=2)
    else:
        draw.ellipse(fallback_bbox, fill=skin_tone, outline=_OUTLINE_COLOR, width=2)

    # Hair = head silhouette minus a protected face-skin window (see
    # _SKIN_WINDOW's own comment). ImageChops.subtract on two 0/255 masks is
    # "head AND NOT skin_window": 255-255=0 inside the protected window,
    # 255-0=255 everywhere else in the head, 0-anything=0 outside the head.
    if hair_tone:
        head_mask = _head_outline_mask(image.size, face_oval, fallback_bbox, face_shape)
        cx, cy = _HEAD_CENTER
        radius_x, radius_y = (fallback_bbox[2] - cx), (fallback_bbox[3] - cy)
        skin_h, skin_v, skin_offset = _SKIN_WINDOW[hair_length]
        skin_cy = cy + radius_y * skin_offset
        skin_window_bbox = (cx - radius_x * skin_h, skin_cy - radius_y * skin_v, cx + radius_x * skin_h, skin_cy + radius_y * skin_v)
        skin_window_mask = Image.new("L", image.size, 0)
        ImageDraw.Draw(skin_window_mask).ellipse(skin_window_bbox, fill=255)
        hair_mask = ImageChops.subtract(head_mask, skin_window_mask)
        hair_layer = Image.new("RGBA", image.size, hair_tone)
        image.paste(hair_layer, (0, 0), hair_mask)

    if nose_center != (0.0, 0.0):
        _draw_nose(draw, nose_center, nose_width_scale, skin_tone)


def _draw_face_features_layer(
    image_size: tuple[int, int],
    left_eye: list[Point],
    right_eye: list[Point],
    left_eyebrow: list[Point],
    right_eyebrow: list[Point],
    width_scale: float,
    brow_color: str,
) -> tuple[Image.Image, Image.Image]:
    """Draws eyebrows and eyes onto their OWN transparent layers, at the same
    head-relative coordinates `_draw_head` used to bake them directly into
    HEAD_RECT before eyebrows/eyes became their own swappable parts (mirrors
    frontend/src/lib/video/avatar/library.ts's "eyebrows"/"eyes" parts) --
    real per-person geometry when available (mediapipe-detected contours),
    else the original two-dot fallback for eyes and no eyebrows at all (same
    "skip when absent" behavior `_draw_head` always had). The caller crops
    each returned layer's own bounding box into its own small rect (see
    `_paste_cropped_bbox`) rather than this function needing to know
    anything about the destination rects itself."""
    eyebrows_layer = Image.new("RGBA", image_size, (0, 0, 0, 0))
    eyes_layer = Image.new("RGBA", image_size, (0, 0, 0, 0))
    eyebrows_draw = ImageDraw.Draw(eyebrows_layer)
    eyes_draw = ImageDraw.Draw(eyes_layer)

    if left_eyebrow:
        _draw_eyebrow(eyebrows_draw, left_eyebrow, brow_color)
    if right_eyebrow:
        _draw_eyebrow(eyebrows_draw, right_eyebrow, brow_color)

    if left_eye and right_eye:
        _draw_eye(eyes_draw, left_eye)
        _draw_eye(eyes_draw, right_eye)
    else:
        cx, cy = _HEAD_CENTER
        eye_offset_x, eye_offset_y, eye_radius = 20 * width_scale, 8, 7
        for sign in (-1, 1):
            ex, ey = cx + sign * eye_offset_x, cy - eye_offset_y
            eyes_draw.ellipse((ex - eye_radius, ey - eye_radius, ex + eye_radius, ey + eye_radius), fill=_EYE_COLOR)

    return eyebrows_layer, eyes_layer


_FACE_FEATURE_CROP_PAD = 6


def _paste_cropped_bbox(dest_image: Image.Image, layer: Image.Image, dest_rect: dict) -> None:
    """Crops `layer` to its own drawn content's tight bounding box (padded a
    few px) and resizes that crop to fill `dest_rect` exactly, pasting it
    into `dest_image` -- the actual mechanism behind moving eyebrows/eyes out
    of the baked head rect and into their own small swappable ones. A
    completely blank layer (`getbbox()` returns None -- e.g. no eyebrows
    detected at all) leaves `dest_rect` untouched/transparent, same
    "nothing to draw" behavior `_draw_head` always had for a missing
    eyebrow."""
    bbox = layer.getbbox()
    if bbox is None:
        return
    x0, y0, x1, y1 = bbox
    x0, y0 = max(0, x0 - _FACE_FEATURE_CROP_PAD), max(0, y0 - _FACE_FEATURE_CROP_PAD)
    x1, y1 = min(layer.width, x1 + _FACE_FEATURE_CROP_PAD), min(layer.height, y1 + _FACE_FEATURE_CROP_PAD)
    cropped = layer.crop((x0, y0, x1, y1)).resize((dest_rect["sWidth"], dest_rect["sHeight"]), Image.LANCZOS)
    dest_image.paste(cropped, (dest_rect["sx"], dest_rect["sy"]), cropped)


# Synthetic mood-eyebrow variants -- shared by both generators below, since
# neither has a real photo of this specific avatar making that expression to
# crop instead (only "neutral" is ever real/cropped). Offsets mirror
# placeholderAtlas.ts's own drawEyebrowPair exactly (inner_y, outer_y, mid_y
# relative to the rect's own vertical center) so a generated avatar's mood
# brows read the same as the seed skins'.
_MOOD_EYEBROW_STYLES: dict[str, tuple[float, float, float]] = {
    "angry": (4, -4, 1),
    "happy": (1, 1, -5),
    "sad": (-4, 4, -1),
}


def _draw_mood_eyebrow(draw: ImageDraw.ImageDraw, rect: dict, style: str, color: str) -> None:
    inner_y, outer_y, mid_y = _MOOD_EYEBROW_STYLES[style]
    center_x = rect["sx"] + rect["sWidth"] / 2
    center_y = rect["sy"] + rect["sHeight"] / 2
    span = 18
    offset_x = 20
    for sign in (-1, 1):
        mid_x = center_x + sign * offset_x
        inner_x = mid_x - sign * span
        outer_x = mid_x + sign * span
        # PIL's ImageDraw has no quadratic-bezier primitive -- a 3-point
        # polyline through the same mid control point placeholderAtlas.ts's
        # quadraticCurveTo uses is close enough at this stroke width/size to
        # read identically.
        draw.line([(inner_x, center_y + inner_y), (mid_x, center_y + mid_y), (outer_x, center_y + outer_y)], fill=color, width=3, joint="curve")


def _draw_closed_eye(draw: ImageDraw.ImageDraw, rect: dict) -> None:
    """Mirrors placeholderAtlas.ts's own drawEyesClosed -- a short curved
    eyelid line in place of the open dot, always `_EYE_COLOR` (eyes are
    never palette-recolored, same as the seed skins)."""
    center_x = rect["sx"] + rect["sWidth"] / 2
    center_y = rect["sy"] + rect["sHeight"] / 2
    offset_x = 20
    radius = 7
    for sign in (-1, 1):
        mid_x = center_x + sign * offset_x
        draw.line([(mid_x - radius, center_y), (mid_x, center_y + 2), (mid_x + radius, center_y)], fill=_EYE_COLOR, width=2, joint="curve")


def _draw_mouth_closed(draw: ImageDraw.ImageDraw, rect: dict, width_scale: float) -> None:
    cx, cy = rect["sx"] + rect["sWidth"] / 2, rect["sy"] + rect["sHeight"] / 2
    half_w = 15 * width_scale
    draw.ellipse((cx - half_w, cy - 3, cx + half_w, cy + 3), fill=_MOUTH_COLOR)


def _draw_mouth_open(draw: ImageDraw.ImageDraw, rect: dict, width_scale: float) -> None:
    cx, cy = rect["sx"] + rect["sWidth"] / 2, rect["sy"] + rect["sHeight"] / 2
    half_w = 11 * width_scale
    draw.ellipse((cx - half_w, cy - 9, cx + half_w, cy + 9), fill=_MOUTH_COLOR)


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
        palette.skin_tone,
        palette.hair_tone,
        palette.face_width_scale,
        palette.face_shape,
        palette.hair_length,
        palette.face_oval,
        palette.nose_center,
        palette.nose_width_scale,
    )
    brow_color = palette.hair_tone or _DEFAULT_BROW_COLOR
    eyebrows_layer, eyes_layer = _draw_face_features_layer(
        image.size, palette.left_eye, palette.right_eye, palette.left_eyebrow, palette.right_eyebrow, palette.face_width_scale, brow_color
    )
    _paste_cropped_bbox(image, eyebrows_layer, EYEBROWS_NEUTRAL_RECT)
    _paste_cropped_bbox(image, eyes_layer, EYES_OPEN_RECT)
    _draw_mood_eyebrow(draw, EYEBROWS_ANGRY_RECT, "angry", brow_color)
    _draw_mood_eyebrow(draw, EYEBROWS_HAPPY_RECT, "happy", brow_color)
    _draw_mood_eyebrow(draw, EYEBROWS_SAD_RECT, "sad", brow_color)
    _draw_closed_eye(draw, EYES_CLOSED_RECT)
    _draw_mouth_closed(draw, MOUTH_CLOSED_RECT, palette.mouth_width_scale)
    _draw_mouth_open(draw, MOUTH_OPEN_RECT, palette.mouth_width_scale)
    _torso_body(draw, TORSO_RECT)
    _rounded_rect(draw, ARM_L_RECT, inset=4, radius=14, fill=palette.skin_tone)
    _rounded_rect(draw, ARM_R_RECT, inset=4, radius=14, fill=palette.skin_tone)
    _rounded_rect(draw, LEG_L_RECT, inset=4, radius=17, fill=_PANTS_COLOR)
    _rounded_rect(draw, LEG_R_RECT, inset=4, radius=17, fill=_PANTS_COLOR)
    _draw_torso_polo(draw, POLO_RECT)
    _draw_torso_blazer(draw, BLAZER_RECT)
    _draw_torso_suit(draw, SUIT_RECT)
    _draw_neck(draw, NECK_RECT, palette.skin_tone)

    buffer = BytesIO()
    image.save(buffer, format="PNG")

    part_rects = {
        "head": HEAD_RECT,
        "mouth": MOUTH_CLOSED_RECT,
        "closed": MOUTH_CLOSED_RECT,
        "open": MOUTH_OPEN_RECT,
        "eyebrows": EYEBROWS_NEUTRAL_RECT,
        "neutral": EYEBROWS_NEUTRAL_RECT,
        "angry": EYEBROWS_ANGRY_RECT,
        "happy": EYEBROWS_HAPPY_RECT,
        "sad": EYEBROWS_SAD_RECT,
        "eyes": EYES_OPEN_RECT,
        "eyeOpen": EYES_OPEN_RECT,
        "eyeClosed": EYES_CLOSED_RECT,
        "torso": TORSO_RECT,
        "armL": ARM_L_RECT,
        "armR": ARM_R_RECT,
        "legL": LEG_L_RECT,
        "legR": LEG_R_RECT,
        "polo": POLO_RECT,
        "blazer": BLAZER_RECT,
        "suit": SUIT_RECT,
        "neck": NECK_RECT,
    }
    return buffer.getvalue(), part_rects


# Vertical/horizontal fraction of head_crop where the REAL face_oval bbox
# sits, derived from face-analysis/src/photo_analysis.py's own
# `_compute_crop_regions` margin factors (_HEAD_CROP_HAIR_MARGIN_FACTOR=0.32
# hair margin added ABOVE the face, _HEAD_CROP_SIDE_MARGIN_FACTOR=0.06 side
# margin either side, and a further flat 1.02 square-ify pad) -- both fixed
# fractions of face_oval's own bbox, not photo-dependent, and unaffected by
# that function's final "shift to stay in-bounds" clamp (a shift moves the
# whole box, not the face's position within it). Solving that math backward:
# the real face top lands ~24% down the crop, the chin ~97% down, and the
# face width occupies the central ~55% -- used below to protect this region
# from ever being zeroed by the background chroma-key, regardless of color.
_FACE_PROTECTED_WIDTH_FRACTION = 0.55
_FACE_PROTECTED_TOP_FRACTION = 0.24
_FACE_PROTECTED_BOTTOM_FRACTION = 0.97


def _border_connected_removal_mask(candidate: Image.Image) -> Image.Image:
    """`candidate` is a single-channel "L" image, 0 = background-colored
    (candidate for removal), 255 = clearly not background. Restricts actual
    removal to whichever 0-valued pixels are 4-connected, via flood fill,
    back to the crop's own border -- a real background region always
    touches the crop's edge (`head_crop` is head-plus-margin, background
    surrounding it on every side), so an isolated same-colored patch
    INSIDE the face (a cartoonify style's flat highlight/shading landing
    close enough to the one sampled background color) has no contiguous
    path back to the edge and is left opaque instead of becoming a
    false-positive translucent hole once the caller blurs this mask.
    Strictly more conservative than a fixed-fraction "protected region"
    guess (see `_FACE_PROTECTED_*` below, kept as an extra belt-and-braces
    layer) -- this can only keep MORE pixels opaque, never fewer, and needs
    no assumption about where the face actually sits in the crop."""
    work = candidate.copy()
    width, height = work.size
    border_points = (
        [(x, 0) for x in range(width)]
        + [(x, height - 1) for x in range(width)]
        + [(0, y) for y in range(height)]
        + [(width - 1, y) for y in range(height)]
    )
    for point in border_points:
        if work.getpixel(point) == 0:
            ImageDraw.floodfill(work, point, 1, thresh=0)
    # 1 = border-connected candidate -> confirmed removal (0). Anything else
    # (0 = an unreached, isolated candidate; 255 = already foreground) stays
    # opaque (255).
    return work.point(lambda v: 0 if v == 1 else 255)


def _background_removal_mask(image: Image.Image, background_rgb: tuple[int, int, int], threshold: int = 45) -> Image.Image:
    """Cheap chroma-key: pixels close to `background_rgb` become transparent
    (mask=0), everything else opaque (mask=255). `ImageChops.difference` +
    `.convert('L')` is a luminance-weighted proxy for color distance, not a
    true Euclidean one -- adequate for a fairly uniform background (this
    project's existing "informal heuristic, no real segmentation model"
    posture, same as photo_analysis.py's own color-sampling code), and
    avoids needing numpy in this venv (backend/ doesn't have it -- mediapipe/
    numpy live only in face-analysis/ now, see that split's own history).
    Only removes background-colored pixels that are actually
    border-connected -- see `_border_connected_removal_mask`."""
    bg_solid = Image.new("RGB", image.size, background_rgb)
    diff = ImageChops.difference(image.convert("RGB"), bg_solid).convert("L")
    candidate = diff.point(lambda v: 0 if v <= threshold else 255)
    return _border_connected_removal_mask(candidate)


def build_atlas_png_from_photo(
    cartoon_image_bytes: bytes, palette: FacePalette
) -> tuple[bytes, dict[str, dict], tuple[float, float]]:
    """The fal.ai-cartoonify path: crops the head and mouth directly out of
    `cartoon_image_bytes` (a real, if AI-stylized, photo -- see
    avatar_gen/cartoonify_provider.py) using `palette.head_crop_box`/
    `mouth_crop_box`/`background_rgb` (raw pixel coordinates for THESE exact
    bytes, computed by photo_analysis.py's `_compute_crop_regions` against
    the SAME image), rather than drawing a parametric cartoon head the way
    `build_atlas_png` above does. Requires `palette.detected` -- the caller

    Returns `(atlas_png_bytes, part_rects, mouth_pivot)` -- the extra
    `mouth_pivot` (absent from `build_atlas_png`'s return above, since that
    path's mouth position is fixed by construction) is this specific
    avatar's own corrected "mouth" part pivot from
    `_compute_photo_mouth_pivot`; the caller (service.py) must use it to
    override `_PARTS`' fixed mouth pivot for this avatar's stored skin, or
    the swappable mouth rect renders in the wrong place on this real photo's
    head.
    (avatar_gen/service.py) only reaches this function once a clear face was
    already confirmed on the original upload, which is also what gates the
    fal.ai spend in the first place.

    The body (torso/arms/legs) is unchanged from `build_atlas_png` -- same
    flat-drawn shapes, same colors. This is a KNOWN, accepted style seam (a
    detailed/shaded cartoon face next to flat-colored primitive limbs) -- see
    [[project_face_analysis_service]]'s notes on why this was tried and kept
    anyway (the alternative, drawing the whole body too, is a separate,
    larger investment not yet scoped)."""
    assert palette.head_crop_box and palette.mouth_crop_box and palette.background_rgb, (
        "build_atlas_png_from_photo requires a detected face's crop regions -- caller must gate on palette.detected"
    )

    cartoon_image = Image.open(BytesIO(cartoon_image_bytes)).convert("RGB")

    head_crop = cartoon_image.crop(tuple(round(v) for v in palette.head_crop_box)).resize(
        (HEAD_RECT["sWidth"], HEAD_RECT["sHeight"]), Image.LANCZOS
    )
    oval_mask = Image.new("L", (HEAD_RECT["sWidth"], HEAD_RECT["sHeight"]), 0)
    ImageDraw.Draw(oval_mask).ellipse((0, 2, HEAD_RECT["sWidth"], HEAD_RECT["sHeight"] - 2), fill=255)

    # `_background_removal_mask` is a per-pixel color-distance check against
    # a SINGLE sampled corner pixel (see that function's own doc comment) --
    # a cartoonify style's flat shading/highlights can still read close
    # enough to that one sampled color to get flagged, and GaussianBlur-ing
    # that binary mask turns any false hit into a partial (not just
    # fully-transparent) alpha value, rendering as a partially see-through
    # FACE rather than a cleanly removed background. That function now
    # restricts removal to border-connected regions only
    # (`_border_connected_removal_mask`), which rules out most false hits
    # (an isolated same-colored patch mid-face has no path back to the
    # crop's edge) -- `protected_mask` below is kept as a second, cheaper
    # belt-and-braces layer on top of that: it keeps the region the geometry
    # guarantees is real face (see `_FACE_PROTECTED_*` above) fully opaque
    # regardless of color, for the rare case a false hit's blob happens to
    # touch the border too (e.g. a bright highlight running from a cheek
    # out through the side margin).
    protected_mask = Image.new("L", (HEAD_RECT["sWidth"], HEAD_RECT["sHeight"]), 0)
    protected_half_w = HEAD_RECT["sWidth"] * _FACE_PROTECTED_WIDTH_FRACTION / 2
    protected_cx = HEAD_RECT["sWidth"] / 2
    protected_top = HEAD_RECT["sHeight"] * _FACE_PROTECTED_TOP_FRACTION
    protected_bottom = HEAD_RECT["sHeight"] * _FACE_PROTECTED_BOTTOM_FRACTION
    ImageDraw.Draw(protected_mask).ellipse(
        (protected_cx - protected_half_w, protected_top, protected_cx + protected_half_w, protected_bottom), fill=255
    )

    bg_mask = _background_removal_mask(head_crop, palette.background_rgb).filter(ImageFilter.GaussianBlur(1.0))
    bg_mask = ImageChops.lighter(bg_mask, protected_mask)
    head_mask = ImageChops.multiply(oval_mask, bg_mask)

    mouth_crop = cartoon_image.crop(tuple(round(v) for v in palette.mouth_crop_box))
    mouth_base = mouth_crop.resize((MOUTH_CLOSED_RECT["sWidth"], MOUTH_CLOSED_RECT["sHeight"]), Image.LANCZOS).convert("RGBA")
    # A single photo of a closed mouth has no actual gap/interior to reveal --
    # geometrically warping it (an earlier approach: stretch then resize back
    # down) either cancels itself out (open/closed render pixel-near-
    # identical) or just shows a distorted closed-lip line, which still
    # doesn't read as "open". A later fix drew a dark gap ellipse on the
    # "open" copy ONLY, leaving "closed" as pure untouched photo -- SAME bug,
    # different cause: "closed" then reads as however dark/light the source
    # photo's own lip color happens to be, which can still land close enough
    # to the drawn gap's color to look barely different, especially against a
    # cartoonify style's own heavy dark outlines. Fixed by drawing a real gap
    # on BOTH copies, at the SAME two sizes _draw_mouth_closed/_draw_mouth_open
    # use on the parametric (non-photo) path below -- a solid_half_h of 3px vs
    # 9px is what actually makes "closed" and "open" differ, not which one
    # happens to have a decal.
    #
    # `gap_color` is sampled from THIS avatar's own real lip pixels (the same
    # cx-15..cx+15 band the closed-mouth ellipse below draws over), darkened
    # for contrast -- not the fixed `_MOUTH_COLOR` constant the parametric
    # path uses, which read as an odd, mismatched color against some skin/lip
    # tones since it never varied per photo. Sampled from `mouth_base` (the
    # untouched photo crop) before either copy below gets a gap drawn onto it.
    #
    # cy MUST be the crop's true vertical center (0.5), not an offset value --
    # photo_analysis.py's `_compute_crop_regions` pads `mouth_crop_box`
    # symmetrically above/below the real outer-lips bbox
    # (`_MOUTH_CROP_PAD_Y_FACTOR`), so the real lips sit centered in
    # `mouth_base` by construction. This used to read `* 0.55` (carried
    # forward from a pre-`mouth_crop_box` version of this function that
    # cropped asymmetrically), which drew the gap/teeth decal a few percent
    # below the crop's actual center -- invisible on its own, but compounding
    # with `_compute_photo_mouth_pivot`'s pivot (which centers the WHOLE
    # mouth rect on the real lips) into the whole flapping-mouth graphic
    # sitting visibly below the avatar's real lips.
    cx, cy = mouth_base.width / 2, mouth_base.height / 2
    sampled_lip_rgb = _average_color(mouth_base, (cx - 15, cy - 4, cx + 15, cy + 4))
    gap_color = _darken("#{:02x}{:02x}{:02x}".format(*sampled_lip_rgb), 0.5)

    mouth_closed = mouth_base.copy()
    ImageDraw.Draw(mouth_closed).ellipse((cx - 15, cy - 3, cx + 15, cy + 3), fill=gap_color)

    # "open" reused the exact same gap_color as "closed", just stretched over
    # a 3x taller ellipse -- a flat dark oval that big reads as a solid dark
    # smudge (much more noticeable than the thin closed-mouth line, even
    # though the fill color is identical). Real open mouths show teeth, not
    # a uniform cavity, so break the fill up: darker cavity ellipse first,
    # then a fixed off-white teeth band across the upper half -- same idea as
    # _MOUTH_COLOR being a fixed, skin-independent constant.
    mouth_open = mouth_base.copy()
    open_draw = ImageDraw.Draw(mouth_open)
    open_draw.ellipse((cx - 11, cy - 9, cx + 11, cy + 9), fill=gap_color)
    open_draw.ellipse((cx - 9, cy - 8, cx + 9, cy - 2), fill=_TEETH_COLOR)

    image = Image.new("RGBA", (CANVAS_WIDTH, CANVAS_HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    image.paste(head_crop.convert("RGBA"), (HEAD_RECT["sx"], HEAD_RECT["sy"]), head_mask)
    image.paste(mouth_closed.convert("RGBA"), (MOUTH_CLOSED_RECT["sx"], MOUTH_CLOSED_RECT["sy"]))
    image.paste(mouth_open.convert("RGBA"), (MOUTH_OPEN_RECT["sx"], MOUTH_OPEN_RECT["sy"]))
    mouth_pivot = _compute_photo_mouth_pivot(palette.head_crop_box, palette.mouth_crop_box)

    # `palette` here was computed by re-running face analysis on THIS SAME
    # cartoonified image (see service.py's `_cartoonify_and_crop`: `analyze_photo(cartoon_bytes)`),
    # so its left_eye/right_eye/left_eyebrow/right_eyebrow are real per-person
    # contours detected on the actual generated head, in the exact same
    # `_remap`-relative coordinate space build_atlas_png's own parametric
    # path uses -- the same `_draw_face_features_layer`/`_paste_cropped_bbox`
    # pipeline applies unchanged, no separate photo-specific eyebrow/eye
    # logic needed. Only the "neutral"/"eyeOpen" shapes are ever real crops;
    # there's no actual photo of this avatar looking angry/happy/sad, so
    # those three (and "eyeClosed") are synthesized exactly like the
    # parametric path's own.
    brow_color = palette.hair_tone or _DEFAULT_BROW_COLOR
    eyebrows_layer, eyes_layer = _draw_face_features_layer(
        image.size, palette.left_eye, palette.right_eye, palette.left_eyebrow, palette.right_eyebrow, palette.face_width_scale, brow_color
    )
    _paste_cropped_bbox(image, eyebrows_layer, EYEBROWS_NEUTRAL_RECT)
    _paste_cropped_bbox(image, eyes_layer, EYES_OPEN_RECT)
    _draw_mood_eyebrow(draw, EYEBROWS_ANGRY_RECT, "angry", brow_color)
    _draw_mood_eyebrow(draw, EYEBROWS_HAPPY_RECT, "happy", brow_color)
    _draw_mood_eyebrow(draw, EYEBROWS_SAD_RECT, "sad", brow_color)
    _draw_closed_eye(draw, EYES_CLOSED_RECT)

    _torso_body(draw, TORSO_RECT)
    _rounded_rect(draw, ARM_L_RECT, inset=4, radius=14, fill=palette.skin_tone)
    _rounded_rect(draw, ARM_R_RECT, inset=4, radius=14, fill=palette.skin_tone)
    _rounded_rect(draw, LEG_L_RECT, inset=4, radius=17, fill=_PANTS_COLOR)
    _rounded_rect(draw, LEG_R_RECT, inset=4, radius=17, fill=_PANTS_COLOR)
    _draw_torso_polo(draw, POLO_RECT)
    _draw_torso_blazer(draw, BLAZER_RECT)
    _draw_torso_suit(draw, SUIT_RECT)
    _draw_neck(draw, NECK_RECT, palette.skin_tone)

    buffer = BytesIO()
    image.save(buffer, format="PNG")

    part_rects = {
        "head": HEAD_RECT,
        "mouth": MOUTH_CLOSED_RECT,
        "closed": MOUTH_CLOSED_RECT,
        "open": MOUTH_OPEN_RECT,
        "eyebrows": EYEBROWS_NEUTRAL_RECT,
        "neutral": EYEBROWS_NEUTRAL_RECT,
        "angry": EYEBROWS_ANGRY_RECT,
        "happy": EYEBROWS_HAPPY_RECT,
        "sad": EYEBROWS_SAD_RECT,
        "eyes": EYES_OPEN_RECT,
        "eyeOpen": EYES_OPEN_RECT,
        "eyeClosed": EYES_CLOSED_RECT,
        "torso": TORSO_RECT,
        "armL": ARM_L_RECT,
        "armR": ARM_R_RECT,
        "legL": LEG_L_RECT,
        "legR": LEG_R_RECT,
        "polo": POLO_RECT,
        "blazer": BLAZER_RECT,
        "suit": SUIT_RECT,
        "neck": NECK_RECT,
    }
    return buffer.getvalue(), part_rects, mouth_pivot
