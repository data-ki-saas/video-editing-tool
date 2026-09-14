"""Server-side mirror of frontend/src/lib/video/avatar/placeholderAtlas.ts --
the SAME fixed grid packing (two shelves: head+both mouth shapes, then
torso+limbs) so a generated skin's `partRects` are guaranteed to validate
against compile.ts's `biped-simple` topology and reads as one house style
alongside the hand-authored seed characters (the avatar plan doc's own
"shared house style" tenet). `palette` (from photo_analysis.py) is the only
input that varies -- part rect position/size is fixed layout math either way.

The head is now drawn from `palette.face_oval`/`left_eye`/`right_eye`/
`left_eyebrow`/`right_eyebrow` -- real per-person contours traced from
mediapipe's own landmark groups (see photo_analysis.py's module doc comment)
-- instead of a 3-bucket outline choice and two fixed dot eyes. The
face_width_scale/face_shape bucket fields still drive a fallback drawing
whenever no contour is available (detected=False; e.g. no face found).
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageChops, ImageDraw, ImageFilter

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


def _box(rect: dict) -> tuple[float, float, float, float]:
    return rect["sx"], rect["sy"], rect["sx"] + rect["sWidth"], rect["sy"] + rect["sHeight"]


def _rounded_rect(draw: ImageDraw.ImageDraw, rect: dict, inset: float, radius: float, fill: str) -> None:
    x0, y0, x1, y1 = _box(rect)
    draw.rounded_rectangle((x0 + inset, y0 + inset, x1 - inset, y1 - inset), radius=radius, fill=fill, outline=_OUTLINE_COLOR, width=2)


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
    left_eye: list[Point],
    right_eye: list[Point],
    left_eyebrow: list[Point],
    right_eyebrow: list[Point],
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

    brow_color = hair_tone or _DEFAULT_BROW_COLOR
    if left_eyebrow:
        _draw_eyebrow(draw, left_eyebrow, brow_color)
    if right_eyebrow:
        _draw_eyebrow(draw, right_eyebrow, brow_color)

    # Eyes drawn LAST so they always stay visible even under generous hair
    # coverage. Real per-eye shapes when available; two simple dots
    # (placeholderAtlas.ts's original look) otherwise.
    if left_eye and right_eye:
        _draw_eye(draw, left_eye)
        _draw_eye(draw, right_eye)
    else:
        cx, cy = _HEAD_CENTER
        eye_offset_x, eye_offset_y, eye_radius = 20 * width_scale, 8, 7
        for sign in (-1, 1):
            ex, ey = cx + sign * eye_offset_x, cy - eye_offset_y
            draw.ellipse((ex - eye_radius, ey - eye_radius, ex + eye_radius, ey + eye_radius), fill=_EYE_COLOR)


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
        palette.left_eye,
        palette.right_eye,
        palette.left_eyebrow,
        palette.right_eyebrow,
        palette.nose_center,
        palette.nose_width_scale,
    )
    _draw_mouth_closed(draw, MOUTH_CLOSED_RECT, palette.mouth_width_scale)
    _draw_mouth_open(draw, MOUTH_OPEN_RECT, palette.mouth_width_scale)
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


# How much taller the mouth-open crop is made vs. the real mouth-closed crop
# -- there's no second "mouth open" photo to crop, so this synthesizes one by
# vertically stretching the real crop. Not a real speech viseme, just enough
# visible motion to read as "talking" -- same fidelity ceiling the drawn
# mouth-swap already had (two fixed shapes, not per-phoneme lip shapes).
_MOUTH_OPEN_STRETCH = 1.7


def _background_removal_mask(image: Image.Image, background_rgb: tuple[int, int, int], threshold: int = 45) -> Image.Image:
    """Cheap chroma-key: pixels close to `background_rgb` become transparent
    (mask=0), everything else opaque (mask=255). `ImageChops.difference` +
    `.convert('L')` is a luminance-weighted proxy for color distance, not a
    true Euclidean one -- adequate for a fairly uniform background (this
    project's existing "informal heuristic, no real segmentation model"
    posture, same as photo_analysis.py's own color-sampling code), and
    avoids needing numpy in this venv (backend/ doesn't have it -- mediapipe/
    numpy live only in face-analysis/ now, see that split's own history)."""
    bg_solid = Image.new("RGB", image.size, background_rgb)
    diff = ImageChops.difference(image.convert("RGB"), bg_solid).convert("L")
    return diff.point(lambda v: 255 if v > threshold else 0)


def build_atlas_png_from_photo(cartoon_image_bytes: bytes, palette: FacePalette) -> tuple[bytes, dict[str, dict]]:
    """The fal.ai-cartoonify path: crops the head and mouth directly out of
    `cartoon_image_bytes` (a real, if AI-stylized, photo -- see
    avatar_gen/cartoonify_provider.py) using `palette.head_crop_box`/
    `mouth_crop_box`/`background_rgb` (raw pixel coordinates for THESE exact
    bytes, computed by photo_analysis.py's `_compute_crop_regions` against
    the SAME image), rather than drawing a parametric cartoon head the way
    `build_atlas_png` above does. Requires `palette.detected` -- the caller
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
    bg_mask = _background_removal_mask(head_crop, palette.background_rgb).filter(ImageFilter.GaussianBlur(1.0))
    head_mask = ImageChops.multiply(oval_mask, bg_mask)

    mouth_crop = cartoon_image.crop(tuple(round(v) for v in palette.mouth_crop_box))
    mouth_closed = mouth_crop.resize((MOUTH_CLOSED_RECT["sWidth"], MOUTH_CLOSED_RECT["sHeight"]), Image.LANCZOS)
    stretched = mouth_crop.resize((mouth_crop.width, round(mouth_crop.height * _MOUTH_OPEN_STRETCH)), Image.LANCZOS)
    mouth_open = stretched.resize((MOUTH_OPEN_RECT["sWidth"], MOUTH_OPEN_RECT["sHeight"]), Image.LANCZOS)

    image = Image.new("RGBA", (CANVAS_WIDTH, CANVAS_HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    image.paste(head_crop.convert("RGBA"), (HEAD_RECT["sx"], HEAD_RECT["sy"]), head_mask)
    image.paste(mouth_closed.convert("RGBA"), (MOUTH_CLOSED_RECT["sx"], MOUTH_CLOSED_RECT["sy"]))
    image.paste(mouth_open.convert("RGBA"), (MOUTH_OPEN_RECT["sx"], MOUTH_OPEN_RECT["sy"]))
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
