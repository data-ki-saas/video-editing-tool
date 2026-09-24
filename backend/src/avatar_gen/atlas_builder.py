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
placeholderAtlas.ts's "eyebrows"/"eyes" parts), not baked into the head.
build_atlas_png's head is entirely drawn (no real feature already sitting
under these rects), so `_draw_face_features_layer` draws real per-person
eyebrow/eye contours (`palette.left_eye`/`right_eye`/`left_eyebrow`/
`right_eyebrow`, falling back to two dots for eyes / nothing for eyebrows
when undetected) onto their own transparent layers, and `_paste_cropped_bbox`
crops+relocates each into its own small rect -- "neutral" eyebrows and
"eyeOpen" get this real per-person art; angry/happy/sad/eyeClosed (no actual
photo of this avatar making those expressions to draw from instead) are
synthesized by `_draw_mood_eyebrow`/`_draw_closed_eye`.
build_atlas_png_from_photo's head, by contrast, IS a real (cartoonified)
photo crop that already shows this exact person's real eyebrows/eyes --
"neutral"/"eyeOpen" are left fully transparent there instead so those real
features show through untouched, and every OTHER shape (angry/happy/sad,
eyeClosed) is synthesized with its own opaque skin-tone backing (an optional
`skin_tone` arg to `_draw_mood_eyebrow`/`_draw_closed_eye`) so it actually
replaces the real feature instead of drawing across it.
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
# Mirrors placeholderAtlas.ts's own MOUTH_LAUGH_RECT -- the mood-driven
# "laugh" mouth override (frontend/src/lib/video/avatar/library.ts's
# MOOD_MOUTH_SHAPES), never picked by word-driven lip-sync itself.
MOUTH_LAUGH_RECT = {
    "sx": MOUTH_CLOSED_RECT["sx"],
    "sy": MOUTH_OPEN_RECT["sy"] + MOUTH_OPEN_RECT["sHeight"] + GAP,
    "sWidth": 50,
    "sHeight": 28,
}

# Mirrors avatar_gen/service.py's own `_PARTS` "head"/"mouth"/"eyebrows"/
# "eyes" entries (pivotX/pivotY, boneIndex=HEAD for all) -- needed here too so
# `_compute_photo_part_pivot` below can reason about where a part's rect
# actually lands relative to "head"'s own rect once both are drawn against
# the SAME bone, without importing service.py (which imports this module,
# not the other way around).
_HEAD_PART_PIVOT = (70, 128)

_ROW2_Y = HEAD_RECT["sy"] + HEAD_RECT["sHeight"] + GAP
TORSO_RECT = {"sx": GAP, "sy": _ROW2_Y, "sWidth": 120, "sHeight": 140}
# Shrunk from the old single 130-tall rigid rect (shoulder-to-hand) down to
# just shoulder-to-elbow -- mirrors frontend/src/lib/video/avatar/library.ts's
# FOREARM_L/FOREARM_R split exactly (see that file's own comment: a real
# elbow joint so a held prop can bend around the face instead of a single
# rigid arm bone sweeping straight through it).
ARM_L_RECT = {"sx": TORSO_RECT["sx"] + TORSO_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 36, "sHeight": 74}
ARM_R_RECT = {"sx": ARM_L_RECT["sx"] + ARM_L_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 36, "sHeight": 74}
# The elbow-to-wrist segment -- same rounded-rect skin-tone look as
# ARM_L_RECT/ARM_R_RECT, just its own independently-posable rect/bone.
FOREARM_L_RECT = {"sx": ARM_R_RECT["sx"] + ARM_R_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 34, "sHeight": 68}
FOREARM_R_RECT = {"sx": FOREARM_L_RECT["sx"] + FOREARM_L_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 34, "sHeight": 68}
LEG_L_RECT = {"sx": FOREARM_R_RECT["sx"] + FOREARM_R_RECT["sWidth"] + GAP, "sy": _ROW2_Y, "sWidth": 42, "sHeight": 150}
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
# Sized/pivoted (service.py's "neck" pivot) so its OPAQUE area (rect minus
# `_draw_neck`'s own inset=4) starts above wherever "head"'s own drawn chin
# can plausibly end and reaches a couple px past the suit's deepest cut
# (topY+44, cx+-26 -- see `_draw_torso_suit`); zOrder places it right after
# "torso" and before "head"/"arms", the same layer conceptually a real neck
# bone would occupy.
#
# The original 50/4 sizing only closed the gap against the CUTOUT's own top
# edge (world y 146, 6px below the torso joint) -- the wrong target: "head"'s
# drawn chin, not the cutout, is the real upper bound of the gap, and it does
# NOT reliably reach that far down. Measured empirically (crop the baked
# "head" rect, walk its center column) against every `_FACE_SHAPE_RADIUS_MULT`
# bucket: "wide" (radius_y mult 0.96, the shortest) ends its opaque chin at
# local row 124 of HEAD_RECT's 140, i.e. world y 132 -- a full 14px above the
# cutout's own top edge. Below that, for ANY torso variant (plain "torso"
# included, not just blazer/suit), nothing was opaque until "torso"'s own
# inset-shrunk top at world y 146 -- a 14px band showing the raw video/photo
# frame straight through right at the collar, regardless of which garment
# was picked. Re-derived to close THAT gap instead: opaque top >= world y 128
# (4px of margin past the "wide" worst case) and opaque bottom >= world y 192
# (2px past the suit's cutout tip at 190) -- pivotY=24 (inset=4 unchanged)
# gives exactly that for the fixed pivot service.py's `_PARTS` uses on the
# PARAMETRIC path, where the chin reliably ends at one of a few known
# `_FACE_SHAPE_RADIUS_MULT` buckets. A same-skin-tone patch overlapping the
# chin by a few px is invisible (head is drawn on top, zOrder 6 > 2, and
# covers it wherever head itself is opaque) -- only a gap, never an overlap,
# is visible here.
#
# sHeight is taller than that fixed pivot alone needs (72 would suffice) --
# the extra headroom is for `_compute_photo_neck_pivot` below, which moves
# the PIVOT (not this rect) for the fal.ai photo path, per-avatar. A real
# photo's chin can end well above the "wide" bucket's worst case (see
# `head_chin_fraction`'s own doc comment in photo_analysis.py -- a face
# wider than it is tall gets the head crop's extra padding split evenly
# above AND below the chin, unlike every hand-tuned parametric bucket, which
# always has the chin sitting near the crop's bottom edge by construction).
# Growing sHeight while leaving `_PARTS`' own fixed pivotY=24 untouched is
# harmless for the parametric path -- "torso" (zOrder 3 > "neck"'s 2) still
# covers the extra opaque area everywhere except the collar cutout, and the
# cutout's own geometry doesn't reach anywhere near this rect's new, lower
# bottom edge.
_ROW4_Y = SUIT_RECT["sy"] + SUIT_RECT["sHeight"] + GAP
_NECK_INSET = 4
NECK_RECT = {"sx": GAP, "sy": _ROW4_Y, "sWidth": 64, "sHeight": 124}

# Row 5 -- hand pose variants, mirrors frontend/src/lib/video/avatar/
# placeholderAtlas.ts's own Row 5 exactly (same rect sizes/order): the rig's
# first real drawn hand (see service.py's own "handL"/"handR" `_PARTS`
# entries, riding new HAND_L/HAND_R bones), replacing the old bare
# arm-end-as-anchor. "open" is each hand's own BASE rect; "fist"/"pointing"
# are per-frame swappable shapes picked by frontend/library.ts's
# GESTURE_HAND_POSE_SHAPES.
_ROW5_Y = NECK_RECT["sy"] + NECK_RECT["sHeight"] + GAP
_HAND_WIDTH = 28
_HAND_HEIGHT = 34
HAND_L_OPEN_RECT = {"sx": GAP, "sy": _ROW5_Y, "sWidth": _HAND_WIDTH, "sHeight": _HAND_HEIGHT}
HAND_L_FIST_RECT = {"sx": HAND_L_OPEN_RECT["sx"] + _HAND_WIDTH + GAP, "sy": _ROW5_Y, "sWidth": _HAND_WIDTH, "sHeight": _HAND_HEIGHT}
HAND_L_POINT_RECT = {"sx": HAND_L_FIST_RECT["sx"] + _HAND_WIDTH + GAP, "sy": _ROW5_Y, "sWidth": _HAND_WIDTH, "sHeight": _HAND_HEIGHT}
HAND_R_OPEN_RECT = {"sx": HAND_L_POINT_RECT["sx"] + _HAND_WIDTH + GAP, "sy": _ROW5_Y, "sWidth": _HAND_WIDTH, "sHeight": _HAND_HEIGHT}
HAND_R_FIST_RECT = {"sx": HAND_R_OPEN_RECT["sx"] + _HAND_WIDTH + GAP, "sy": _ROW5_Y, "sWidth": _HAND_WIDTH, "sHeight": _HAND_HEIGHT}
HAND_R_POINT_RECT = {"sx": HAND_R_FIST_RECT["sx"] + _HAND_WIDTH + GAP, "sy": _ROW5_Y, "sWidth": _HAND_WIDTH, "sHeight": _HAND_HEIGHT}

# Row 6 -- "torsoTrim", mirrors placeholderAtlas.ts's own Row 6 exactly: a
# small overlay part riding the SAME bone/pivot as "torso" (service.py's
# `_PARTS`), carrying only collar/button accent linework, so `trimColor` can
# recolor it independently of `shirtColor` (a second color slot can't safely
# share "torso"'s own rect -- a flat-fill recolor there would just overwrite
# whichever slot resolves second). Same size as TORSO_RECT so "torso"'s own
# pivot keeps it pixel-aligned regardless of where either rect is packed.
_ROW6_Y = _ROW5_Y + _HAND_HEIGHT + GAP
TORSO_TRIM_BASE_RECT = {"sx": GAP, "sy": _ROW6_Y, "sWidth": TORSO_RECT["sWidth"], "sHeight": TORSO_RECT["sHeight"]}
TORSO_TRIM_POLO_RECT = {
    "sx": TORSO_TRIM_BASE_RECT["sx"] + TORSO_TRIM_BASE_RECT["sWidth"] + GAP,
    "sy": _ROW6_Y,
    "sWidth": TORSO_RECT["sWidth"],
    "sHeight": TORSO_RECT["sHeight"],
}
TORSO_TRIM_BLAZER_RECT = {
    "sx": TORSO_TRIM_POLO_RECT["sx"] + TORSO_TRIM_POLO_RECT["sWidth"] + GAP,
    "sy": _ROW6_Y,
    "sWidth": TORSO_RECT["sWidth"],
    "sHeight": TORSO_RECT["sHeight"],
}
TORSO_TRIM_SUIT_RECT = {
    "sx": TORSO_TRIM_BLAZER_RECT["sx"] + TORSO_TRIM_BLAZER_RECT["sWidth"] + GAP,
    "sy": _ROW6_Y,
    "sWidth": TORSO_RECT["sWidth"],
    "sHeight": TORSO_RECT["sHeight"],
}

# Real photos whose face is unusually wide relative to its height push
# `head_chin_fraction` well below what any parametric bucket ever produced --
# clamped so a pathological photo can't demand a pivot the rect above has no
# headroom for (see NECK_RECT's own comment for how its sHeight was sized
# against this exact floor).
_NECK_CHIN_FRACTION_MIN = 0.55
# Same margin the original hand-derived pivotY=24 baked in ("4px of margin
# past the worst case") -- kept identical so re-deriving the formula below
# reproduces that constant exactly for the bucket-equivalent fraction
# (verified: frac=124/140 -> pivotY=24, see `_compute_photo_neck_pivot`).
_NECK_CHIN_OVERLAP_MARGIN = 4

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

CANVAS_WIDTH = (
    max(
        LEG_R_RECT["sx"] + LEG_R_RECT["sWidth"],
        SUIT_RECT["sx"] + SUIT_RECT["sWidth"],
        EYES_OPEN_RECT["sx"] + EYES_OPEN_RECT["sWidth"],
        TORSO_TRIM_SUIT_RECT["sx"] + TORSO_TRIM_SUIT_RECT["sWidth"],
    )
    + GAP
)
CANVAS_HEIGHT = TORSO_TRIM_BASE_RECT["sy"] + TORSO_TRIM_BASE_RECT["sHeight"] + GAP

# Kept fixed (not photo-derived) -- only skin/hair tone vary per generated
# character, same scope placeholderAtlas.ts's own PlaceholderAtlasPalette
# gives a caller (shirt/pants/mouth/eye/outline colors are its own fixed
# module constants there too).
_SHIRT_COLOR = "#3f6fb0"
_PANTS_COLOR = "#2b2b3d"
_MOUTH_COLOR = "#7a2f2f"
_TEETH_COLOR = "#f2e9df"
_EYE_COLOR = "#2a2a2a"
_EYE_SCLERA_COLOR = "#f5f0e8"
# Fraction of the eye contour's own bbox height -- how big a dark iris/pupil
# circle to draw centered inside the sclera fill (see _draw_eye's own doc
# comment for why a plain flat fill isn't enough here).
_EYE_IRIS_RADIUS_FRACTION = 0.34
_DEFAULT_BROW_COLOR = "#3a2a1f"
_OUTLINE_COLOR = (0, 0, 0, 46)  # rgba(0,0,0,0.18) baked to RGBA
# The "trimColor" slot's fixed default (service.py's own _COLOR_SLOTS) -- a
# plain off-white piping/button accent, not part of FacePalette since nothing
# customizes it per generated avatar today, same fixed-constant posture as
# _EYE_COLOR/_DEFAULT_BROW_COLOR above. Matches
# frontend/src/lib/video/avatar/placeholderAtlas.ts's own TRIM_COLOR.
_TRIM_COLOR = "#f2e9df"

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


def _compute_photo_part_pivot(
    head_crop_box: tuple[float, float, float, float], feature_crop_box: tuple[float, float, float, float], part_rect: dict
) -> tuple[float, float]:
    """Where a head-bone-anchored part's pivot needs to be so its rect lands
    exactly over THIS photo's real feature (mouth, eyebrows, eyes...),
    instead of service.py's `_PARTS`/this frontend mirror's fixed pivot for
    that part -- which assumes the feature sits at a constant fraction down
    the head crop, true only for the procedurally-drawn parametric head
    (`build_atlas_png` above), not a real photo (a real face's mouth/brow/eye
    position within its own square, hair-margin-padded head crop varies with
    that person's proportions and framing). Originally written for "mouth"
    only (see git history); generalized to also cover "eyebrows"/"eyes" once
    those became their own swappable parts and hit the exact same bug --
    those two are drawn onto the shared canvas via a DIFFERENT mechanism
    (mediapipe contour -> `_remap` -> crop-to-content -> paste, not a direct
    photo crop like the mouth), but the pivot math only needs each feature's
    own real, un-normalized bounding box (`FacePalette.mouth_crop_box` /
    `eyebrow_crop_box` / `eye_crop_box`) and doesn't care how the pasted
    pixels themselves were produced.

    Derivation: renderer.ts draws a part's rect at bone-local offset
    (-pivotX, -pivotY), and both "head" and this part share the SAME bone, so
    a point at rect-local (px, py) in the part's own image lands at head-image
    pixel `_HEAD_PART_PIVOT + (px - pivotX, py - pivotY)` (since "head"'s
    own rect is drawn at bone-local offset -_HEAD_PART_PIVOT, i.e. head-image
    pixel 0 IS bone-local -_HEAD_PART_PIVOT). Solving for the pivot that puts
    the part rect's CENTER at the real feature's fractional position
    (fracX, fracY) within the head crop:
        pivot = _HEAD_PART_PIVOT + (rectSize / 2) - frac * HEAD_RECT_size
    """
    hx0, hy0, hx1, hy1 = head_crop_box
    fx0, fy0, fx1, fy1 = feature_crop_box
    frac_x = ((fx0 + fx1) / 2 - hx0) / max(1.0, hx1 - hx0)
    frac_y = ((fy0 + fy1) / 2 - hy0) / max(1.0, hy1 - hy0)
    pivot_x = _HEAD_PART_PIVOT[0] + part_rect["sWidth"] / 2 - frac_x * HEAD_RECT["sWidth"]
    pivot_y = _HEAD_PART_PIVOT[1] + part_rect["sHeight"] / 2 - frac_y * HEAD_RECT["sHeight"]
    return pivot_x, pivot_y


# service.py's `_PARTS` "neck" pivotX -- kept as a plain literal here (not
# imported, to avoid a service.py<->atlas_builder.py import cycle, same
# constraint `_HEAD_PART_PIVOT` above already works around) since "neck"
# never needs horizontal correction: unlike mouth/eyebrows/eyes, it isn't a
# real photo feature being aligned to, just a plain filler rect centered
# under the head regardless of this specific photo's proportions.
_NECK_PIVOT_X = 32


def _compute_photo_neck_pivot(head_chin_fraction: float | None) -> tuple[float, float]:
    """Where the "neck" part's pivot needs to be so its opaque top reaches
    (with a small overlap margin) THIS photo's real chin, instead of
    service.py's `_PARTS` fixed pivotY=24 -- which assumes the chin always
    ends at a fixed fraction of the head crop, true only for the
    procedurally-drawn parametric head's known `_FACE_SHAPE_RADIUS_MULT`
    buckets (see NECK_RECT's own doc comment), not a real photo (a real
    face's `head_chin_fraction` varies with how much the head crop's
    square-ing padded the chin away from the crop's own bottom edge -- see
    that field's own doc comment in photo_analysis.py). Same "don't assume a
    constant fraction of the head crop" bug class `_compute_photo_part_pivot`
    above already fixes for mouth/eyebrows/eyes, just anchored to a
    DIFFERENT bone ("neck" rides "torso", not "head"), so it needs its own
    (simpler -- no horizontal component, no feature-crop-box input) formula.

    Derivation: "head"'s bone sits at local offset (0, -12) from "torso"
    (library.ts's DEFAULT_LOCAL_POSE), and "head"'s own rect is drawn at
    bone-local offset -_HEAD_PART_PIVOT, so head-image row r lands at
    torso-bone-local y = -12 + (r - _HEAD_PART_PIVOT[1]). The real chin sits
    at head-image row `head_chin_fraction * HEAD_RECT["sHeight"]`, giving its
    torso-local y = head_chin_fraction * HEAD_RECT["sHeight"] - HEAD_RECT["sHeight"]
    (the -12 and -_HEAD_PART_PIVOT[1] terms cancel exactly against
    `_HEAD_PART_PIVOT[1]` == HEAD_RECT["sHeight"] - 12). "neck"'s own opaque
    top sits at head-image-equivalent torso-local y = _NECK_INSET - pivotY.
    Setting that equal to the chin's torso-local y, minus
    `_NECK_CHIN_OVERLAP_MARGIN` (so the patch reaches a few px PAST the chin,
    guaranteeing overlap despite any rounding -- same margin the original
    hand-derived pivotY=24 baked in) and solving for pivotY:
        pivotY = _NECK_INSET + _NECK_CHIN_OVERLAP_MARGIN
                 + HEAD_RECT["sHeight"] * (1 - head_chin_fraction)
    Verified this reproduces the original hand-measured constant exactly:
    the "wide" parametric bucket's chin fraction (124/140) plugs in to give
    pivotY=24, the exact value `_PARTS`/this module's own fixed-path
    NECK_RECT pivot has always used.

    `head_chin_fraction=None` (no detected face; shouldn't normally reach
    here, since the fal.ai path requires `palette.detected`) falls back to
    `_NECK_CHIN_FRACTION_MIN`'s own worst case rather than guessing 1.0 --
    erring toward "reaches too far up" (invisible, covered by head) rather
    than "leaves a gap"."""
    frac = _NECK_CHIN_FRACTION_MIN if head_chin_fraction is None else head_chin_fraction
    frac = max(_NECK_CHIN_FRACTION_MIN, min(1.0, frac))
    pivot_y = _NECK_INSET + _NECK_CHIN_OVERLAP_MARGIN + HEAD_RECT["sHeight"] * (1 - frac)
    return _NECK_PIVOT_X, pivot_y


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
    _rounded_rect(draw, rect, inset=_NECK_INSET, radius=10, fill=skin_tone)


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


def _draw_hand_base(draw: ImageDraw.ImageDraw, rect: dict, skin_tone: str) -> None:
    """The plain rounded-paddle hand shape every pose below starts from --
    mirrors placeholderAtlas.ts's drawHandBase."""
    _rounded_rect(draw, rect, inset=2, radius=10, fill=skin_tone)


def _draw_hand_open(draw: ImageDraw.ImageDraw, rect: dict, skin_tone: str) -> None:
    """"Open" -- the plain hand base plus two shallow notches cut into the
    far edge, reading as slightly-separated fingers. Mirrors
    placeholderAtlas.ts's drawHandOpen. `fill=(0, 0, 0, 0)` genuinely erases
    alpha here rather than compositing (PIL's ImageDraw sets raw RGBA pixel
    values), same technique `_cut_garment_notch` already uses."""
    _draw_hand_base(draw, rect, skin_tone)
    cx = rect["sx"] + rect["sWidth"] / 2
    bottom_y = rect["sy"] + rect["sHeight"]
    for dx in (-6, 6):
        draw.ellipse((cx + dx - 2.5, bottom_y - 7, cx + dx + 2.5, bottom_y + 3), fill=(0, 0, 0, 0))


def _draw_hand_fist(draw: ImageDraw.ImageDraw, rect: dict, skin_tone: str) -> None:
    """"Fist" -- a plain, more compact rounded blob with no finger notches at
    all. Mirrors placeholderAtlas.ts's drawHandFist."""
    x0, y0, x1, y1 = _box(rect)
    draw.rounded_rectangle((x0 + 3, y0 + 3, x1 - 3, y1 - 10), radius=10, fill=skin_tone, outline=_OUTLINE_COLOR, width=2)


def _draw_hand_pointing(draw: ImageDraw.ImageDraw, rect: dict, skin_tone: str) -> None:
    """"Pointing" -- the fist base plus one thin extended finger protruding
    past its far (bottom) edge. Mirrors placeholderAtlas.ts's
    drawHandPointing."""
    cx = rect["sx"] + rect["sWidth"] / 2
    x0, y0, x1, y1 = _box(rect)
    draw.rounded_rectangle((x0 + 4, y0 + 3, x1 - 4, y0 + rect["sHeight"] * 0.63), radius=9, fill=skin_tone, outline=_OUTLINE_COLOR, width=2)
    finger_top = y0 + rect["sHeight"] * 0.55
    finger_bottom = finger_top + rect["sHeight"] * 0.42
    draw.rounded_rectangle((cx - 3, finger_top, cx + 3, finger_bottom), radius=2, fill=skin_tone, outline=_OUTLINE_COLOR, width=1)


def _draw_trim_button(draw: ImageDraw.ImageDraw, cx: float, cy: float, color: str) -> None:
    """One small filled accent circle -- shared by every _draw_torso_trim_*
    below. Always a single flat `color` with no outline (unlike
    _fill_garment_triangle's silhouette shapes), since this whole part is
    meant to stay a single recolorable flat-fill region -- an outline in a
    second, fixed color would survive a trimColor recolor unchanged."""
    draw.ellipse((cx - 4, cy - 4, cx + 4, cy + 4), fill=color)


def _draw_torso_trim_polo(draw: ImageDraw.ImageDraw, rect: dict, color: str) -> None:
    """"Polo" trim -- three small buttons down the front center, below where
    "torso"'s own polo collar points are drawn. Mirrors
    placeholderAtlas.ts's drawTorsoTrimPolo."""
    cx = rect["sx"] + rect["sWidth"] / 2
    top_y = rect["sy"] + 30
    for i in range(3):
        _draw_trim_button(draw, cx, top_y + i * 22, color)


def _draw_torso_trim_blazer(draw: ImageDraw.ImageDraw, rect: dict, color: str) -> None:
    """"Blazer" trim -- a thin piping stroke tracing the SAME open notch
    "torso"'s own _draw_torso_blazer cuts, plus one waist-closure button.
    Mirrors placeholderAtlas.ts's drawTorsoTrimBlazer."""
    cx = rect["sx"] + rect["sWidth"] / 2
    top_y = rect["sy"] + 6
    draw.line([(cx - 20, top_y), (cx, top_y + 30), (cx + 20, top_y)], fill=color, width=3, joint="curve")
    _draw_trim_button(draw, cx, rect["sy"] + rect["sHeight"] - 30, color)


def _draw_torso_trim_suit(draw: ImageDraw.ImageDraw, rect: dict, color: str) -> None:
    """"Suit" trim -- piping along the deeper suit notch (same coordinates as
    _draw_torso_suit's own cut) plus two closure buttons. Mirrors
    placeholderAtlas.ts's drawTorsoTrimSuit."""
    cx = rect["sx"] + rect["sWidth"] / 2
    top_y = rect["sy"] + 6
    draw.line([(cx - 26, top_y), (cx, top_y + 44), (cx + 26, top_y)], fill=color, width=3, joint="curve")
    for i in range(2):
        _draw_trim_button(draw, cx, top_y + 56 + i * 22, color)


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
    """Fills the real per-person eye contour (mediapipe's palpebral-fissure
    outline -- the eye OPENING's boundary, not an iris/pupil shape) with a
    light sclera color, then draws a dark iris/pupil circle centered inside
    it. Filling the whole contour with `_EYE_COLOR` (this function's
    previous behavior) painted the entire eye -- whites included -- as one
    flat dark shape: harmless for the hand-drawn seed skins' own fixed-size
    eye dot (placeholderAtlas.ts's drawEyesOpen, which never claimed to be a
    whole eye, just a small dot), but a real per-person contour is bigger
    and more irregular, so the same flat-fill treatment reads as a solid
    black blob instead of a natural eye."""
    pixel_points = _remap_all(points)
    draw.polygon(pixel_points, fill=_EYE_SCLERA_COLOR)
    xs = [x for x, _ in pixel_points]
    ys = [y for _, y in pixel_points]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    radius = (max(ys) - min(ys)) * _EYE_IRIS_RADIUS_FRACTION
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=_EYE_COLOR)


def _smooth_curve_points(points: list[tuple[float, float]], samples_per_segment: int = 8) -> list[tuple[float, float]]:
    """Upsamples a sparse polyline into a smooth Catmull-Rom spline through
    EVERY one of its original points -- PIL's ImageDraw has no bezier/spline
    primitive, and connecting the raw points directly with straight
    `draw.line` segments (`joint="curve"` only rounds the corner, it doesn't
    smooth the path itself) reads as a jagged zigzag rather than a natural
    brow arc, especially at mediapipe's sparse 5-point eyebrow resolution or
    the synthetic mood-eyebrow curve's own 3 points. Falls back to the input
    unchanged below 3 points, where "a curve" isn't a meaningful concept."""
    if len(points) < 3:
        return points
    padded = [points[0], *points, points[-1]]
    result: list[tuple[float, float]] = []
    for i in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[i - 1], padded[i], padded[i + 1], padded[i + 2]
        for s in range(samples_per_segment):
            t = s / samples_per_segment
            t2, t3 = t * t, t * t * t
            x = 0.5 * (
                2 * p1[0]
                + (p2[0] - p0[0]) * t
                + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * t3
            )
            y = 0.5 * (
                2 * p1[1]
                + (p2[1] - p0[1]) * t
                + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * t3
            )
            result.append((x, y))
    result.append(points[-1])
    return result


def _draw_eyebrow(draw: ImageDraw.ImageDraw, points: list[Point], color: str) -> None:
    pixel_points = _remap_all(points)
    if len(pixel_points) < 2:
        return
    # width=7 (was 4) -- a real eyebrow is a hair BAND with visible thickness,
    # not a hairline; a thin stroke read as noticeably thinner than the real
    # brow already visible underneath in the photo-avatar path (the head
    # crop is a real photo/cartoon that already shows the person's actual
    # eyebrows), making this synthetic overlay look like it "misses" them.
    draw.line(_smooth_curve_points(pixel_points), fill=color, width=7, joint="curve")
    # Round caps -- draw.line's joints round inner corners but not the two
    # open ends, which otherwise look like a chopped-off stroke.
    radius = 3.5
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
    few px) and pastes it, CENTERED, into `dest_image` at `dest_rect` -- the
    actual mechanism behind moving eyebrows/eyes out of the baked head rect
    and into their own small swappable ones. Scales uniformly (by whichever
    axis is more constrained) rather than resizing to `dest_rect`'s exact
    width AND height, which would stretch/squash the crop whenever its own
    aspect ratio doesn't happen to match `dest_rect`'s fixed one -- a real
    per-person eye/eyebrow contour's bbox aspect ratio varies per photo, so a
    non-uniform resize was warping eyes into a visibly wrong (stretched or
    squashed) shape. Centering (rather than anchoring to `dest_rect`'s
    corner) keeps this consistent with `_compute_photo_part_pivot`, which
    already assumes the pasted content's center sits at `dest_rect`'s own
    center. A completely blank layer (`getbbox()` returns None -- e.g. no
    eyebrows detected at all) leaves `dest_rect` untouched/transparent, same
    "nothing to draw" behavior `_draw_head` always had for a missing
    eyebrow."""
    bbox = layer.getbbox()
    if bbox is None:
        return
    x0, y0, x1, y1 = bbox
    x0, y0 = max(0, x0 - _FACE_FEATURE_CROP_PAD), max(0, y0 - _FACE_FEATURE_CROP_PAD)
    x1, y1 = min(layer.width, x1 + _FACE_FEATURE_CROP_PAD), min(layer.height, y1 + _FACE_FEATURE_CROP_PAD)
    cropped = layer.crop((x0, y0, x1, y1))
    scale = min(dest_rect["sWidth"] / cropped.width, dest_rect["sHeight"] / cropped.height)
    scaled_width, scaled_height = max(1, round(cropped.width * scale)), max(1, round(cropped.height * scale))
    scaled = cropped.resize((scaled_width, scaled_height), Image.LANCZOS)
    paste_x = dest_rect["sx"] + (dest_rect["sWidth"] - scaled_width) // 2
    paste_y = dest_rect["sy"] + (dest_rect["sHeight"] - scaled_height) // 2
    dest_image.paste(scaled, (paste_x, paste_y), scaled)


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


_MOOD_EYEBROW_SUPERSAMPLE = 4
_MOOD_EYEBROW_MARGIN = 12


def _draw_mood_eyebrow(image: Image.Image, rect: dict, style: str, color: str, skin_tone: str | None = None) -> None:
    """`skin_tone`, when given, first strokes the SAME curve much wider in
    that color before drawing the real line -- an opaque backing so this
    shape actually REPLACES a real photo eyebrow already sitting under this
    rect (build_atlas_png_from_photo) rather than drawing across it. This
    intentionally follows the curve's own footprint rather than filling the
    whole `rect`: an earlier version flood-filled the entire rect, which
    covers glasses-frame pixels that reach into this same rect but sit above
    or below the eyebrow itself -- see [[project_avatar_photo_eyes_transparency_fix]]
    for the real avatar this silently broke (the top rim of a pair of
    glasses got erased whenever a mood beat fired).

    Drawn on its own small patch at `_MOOD_EYEBROW_SUPERSAMPLE`x scale, then
    LANCZOS-downscaled back to 1x before pasting -- PIL's `ImageDraw.line`
    has no native anti-aliasing, so at this rect's actual size (60x16) and
    stroke width (3px) the curve rasterized with visibly jagged/stair-stepped
    edges even though `_smooth_curve_points` already makes the underlying
    PATH itself geometrically smooth (that fixed the zigzag shape, not the
    hard-edged rendering of it). Mirrors the same big-then-downscale trick
    `_paste_cropped_bbox` already relies on for the real per-person "neutral"
    eyebrow -- applied here to a small local patch instead of a full-canvas
    layer, since this curve is synthetic and has no real bbox to crop from.
    `_MOOD_EYEBROW_MARGIN` (12) covers the curve's own overshoot past `rect`
    (offset_x=20, span=18 puts the outer endpoint ~8px outside `rect`) plus
    stroke half-width; the patch is mostly transparent outside the actual
    stroke, so pasting it back with its own alpha as mask can't clobber
    neighboring atlas cells even where the padded patch geometrically
    overlaps them."""
    inner_y, outer_y, mid_y = _MOOD_EYEBROW_STYLES[style]
    ss = _MOOD_EYEBROW_SUPERSAMPLE
    margin = _MOOD_EYEBROW_MARGIN
    patch_w, patch_h = rect["sWidth"] + margin * 2, rect["sHeight"] + margin * 2
    patch = Image.new("RGBA", (patch_w * ss, patch_h * ss), (0, 0, 0, 0))
    patch_draw = ImageDraw.Draw(patch)

    center_x = (margin + rect["sWidth"] / 2) * ss
    center_y = (margin + rect["sHeight"] / 2) * ss
    span = 18 * ss
    offset_x = 20 * ss
    for sign in (-1, 1):
        mid_x = center_x + sign * offset_x
        inner_x = mid_x - sign * span
        outer_x = mid_x + sign * span
        # A plain 3-point polyline through (inner, mid, outer) draws a sharp
        # angular corner AT mid, not the smooth arc placeholderAtlas.ts's own
        # real `quadraticCurveTo` draws through the same 3 points -- PIL has
        # no bezier primitive, so `_smooth_curve_points` approximates one by
        # upsampling a Catmull-Rom spline through these same points instead.
        curve = _smooth_curve_points(
            [(inner_x, center_y + inner_y * ss), (mid_x, center_y + mid_y * ss), (outer_x, center_y + outer_y * ss)]
        )
        if skin_tone:
            patch_draw.line(curve, fill=skin_tone, width=12 * ss, joint="curve")
        patch_draw.line(curve, fill=color, width=3 * ss, joint="curve")

    downscaled = patch.resize((patch_w, patch_h), Image.LANCZOS)
    image.paste(downscaled, (rect["sx"] - margin, rect["sy"] - margin), downscaled)


def _draw_closed_eye(draw: ImageDraw.ImageDraw, rect: dict, skin_tone: str | None = None) -> None:
    """Mirrors placeholderAtlas.ts's own drawEyesClosed -- a short curved
    eyelid line in place of the open dot, always `_EYE_COLOR` (eyes are
    never palette-recolored, same as the seed skins). `skin_tone`, when
    given, first fills the WHOLE `rect` -- an opaque backing so this shape
    actually REPLACES a real (still open, per the underlying photo) eye
    already sitting under this rect (build_atlas_png_from_photo) rather than
    drawing a line across it. A full rect, not an inset shape: `eye_crop_box`
    is a tight, unpadded bbox around the real detected contour, so tried an
    inset ellipse first, sized to leave a glasses frame's rim uncovered --
    that left a visible sliver of the real (open) eye's white sclera peeking
    out past the ellipse instead, which reads as far more broken than a
    glasses frame losing a small piece of its rim near the eye. Empirically,
    that risk is much smaller here than for `_draw_mood_eyebrow`'s own
    backing: a lens's glass opening is usually bigger than the eye's own
    tight bbox, so a full-rect eye patch tends to land inside the lens,
    nowhere near the frame's rim -- see [[project_avatar_photo_eyes_transparency_fix]]
    for the real avatar this was checked against."""
    center_x = rect["sx"] + rect["sWidth"] / 2
    center_y = rect["sy"] + rect["sHeight"] / 2
    offset_x = 20
    radius = 7
    if skin_tone:
        x0, y0, x1, y1 = _box(rect)
        draw.rectangle((x0, y0, x1, y1), fill=skin_tone)
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


def _draw_mouth_laugh(draw: ImageDraw.ImageDraw, rect: dict, width_scale: float) -> None:
    """Mirrors placeholderAtlas.ts's own drawMouthLaugh -- toothier and
    TALLER than _draw_mouth_open's plain talk-flap ellipse (not flatter, as
    an earlier version drew it), with corners hooking up and back in toward
    center -- an actual curled-up lip tip stretched upward, not a straight
    diagonal crease. Teeth sit in the MIDDLE of the cavity, not hugging its
    top edge."""
    cx, cy = rect["sx"] + rect["sWidth"] / 2, rect["sy"] + rect["sHeight"] / 2
    half_w = 15 * width_scale
    draw.ellipse((cx - half_w, cy - 10, cx + half_w, cy + 10), fill=_MOUTH_COLOR)
    for sign in (-1, 1):
        draw.line(
            [(cx + sign * (half_w - 1), cy + 4), (cx + sign * (half_w + 3), cy - 4), (cx + sign * (half_w - 2), cy - 12)],
            fill=_OUTLINE_COLOR,
            width=3,
            joint="curve",
        )
    teeth_half_w = 11 * width_scale
    draw.ellipse((cx - teeth_half_w, cy - 4, cx + teeth_half_w, cy + 4), fill=_TEETH_COLOR)


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
    _draw_mood_eyebrow(image, EYEBROWS_ANGRY_RECT, "angry", brow_color)
    _draw_mood_eyebrow(image, EYEBROWS_HAPPY_RECT, "happy", brow_color)
    _draw_mood_eyebrow(image, EYEBROWS_SAD_RECT, "sad", brow_color)
    _draw_closed_eye(draw, EYES_CLOSED_RECT)
    _draw_mouth_closed(draw, MOUTH_CLOSED_RECT, palette.mouth_width_scale)
    _draw_mouth_open(draw, MOUTH_OPEN_RECT, palette.mouth_width_scale)
    _draw_mouth_laugh(draw, MOUTH_LAUGH_RECT, palette.mouth_width_scale)
    _torso_body(draw, TORSO_RECT)
    _rounded_rect(draw, ARM_L_RECT, inset=4, radius=14, fill=palette.skin_tone)
    _rounded_rect(draw, ARM_R_RECT, inset=4, radius=14, fill=palette.skin_tone)
    _rounded_rect(draw, FOREARM_L_RECT, inset=4, radius=13, fill=palette.skin_tone)
    _rounded_rect(draw, FOREARM_R_RECT, inset=4, radius=13, fill=palette.skin_tone)
    _rounded_rect(draw, LEG_L_RECT, inset=4, radius=17, fill=_PANTS_COLOR)
    _rounded_rect(draw, LEG_R_RECT, inset=4, radius=17, fill=_PANTS_COLOR)
    _draw_torso_polo(draw, POLO_RECT)
    _draw_torso_blazer(draw, BLAZER_RECT)
    _draw_torso_suit(draw, SUIT_RECT)
    _draw_neck(draw, NECK_RECT, palette.skin_tone)
    _draw_hand_open(draw, HAND_L_OPEN_RECT, palette.skin_tone)
    _draw_hand_fist(draw, HAND_L_FIST_RECT, palette.skin_tone)
    _draw_hand_pointing(draw, HAND_L_POINT_RECT, palette.skin_tone)
    _draw_hand_open(draw, HAND_R_OPEN_RECT, palette.skin_tone)
    _draw_hand_fist(draw, HAND_R_FIST_RECT, palette.skin_tone)
    _draw_hand_pointing(draw, HAND_R_POINT_RECT, palette.skin_tone)
    # TORSO_TRIM_BASE_RECT is left blank on purpose -- a plain shirt has no
    # trim accent (see its own doc comment above).
    _draw_torso_trim_polo(draw, TORSO_TRIM_POLO_RECT, _TRIM_COLOR)
    _draw_torso_trim_blazer(draw, TORSO_TRIM_BLAZER_RECT, _TRIM_COLOR)
    _draw_torso_trim_suit(draw, TORSO_TRIM_SUIT_RECT, _TRIM_COLOR)

    buffer = BytesIO()
    image.save(buffer, format="PNG")

    part_rects = {
        "head": HEAD_RECT,
        "mouth": MOUTH_CLOSED_RECT,
        "closed": MOUTH_CLOSED_RECT,
        "open": MOUTH_OPEN_RECT,
        "laughOpen": MOUTH_LAUGH_RECT,
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
        "forearmL": FOREARM_L_RECT,
        "forearmR": FOREARM_R_RECT,
        "legL": LEG_L_RECT,
        "legR": LEG_R_RECT,
        "polo": POLO_RECT,
        "blazer": BLAZER_RECT,
        "suit": SUIT_RECT,
        "neck": NECK_RECT,
        "handL": HAND_L_OPEN_RECT,
        "handR": HAND_R_OPEN_RECT,
        "handLFist": HAND_L_FIST_RECT,
        "handLPoint": HAND_L_POINT_RECT,
        "handRFist": HAND_R_FIST_RECT,
        "handRPoint": HAND_R_POINT_RECT,
        "torsoTrim": TORSO_TRIM_BASE_RECT,
        "torsoTrim::polo": TORSO_TRIM_POLO_RECT,
        "torsoTrim::blazer": TORSO_TRIM_BLAZER_RECT,
        "torsoTrim::suit": TORSO_TRIM_SUIT_RECT,
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
    (mask=0), everything else opaque (mask=255). Distance is the true
    per-channel MAX difference (a Chebyshev distance, via three
    `ImageChops.lighter` calls on the split diff channels) -- pure Pillow, no
    numpy needed in this venv (backend/ doesn't have it -- mediapipe/numpy
    live only in face-analysis/ now, see that split's own history). This used
    to `.convert('L')` the diff instead (`R*0.299 + G*0.587 + B*0.114`,
    Pillow's standard luma weights) -- a real bug, not just an approximation:
    a warm-cream photo background and a warm skin highlight can differ by 80+
    in the BLUE channel alone yet still land under threshold once that's
    diluted to 11.4% weight, misclassifying real forehead skin as background
    -- reported as a persistent transparent forehead band on one specific
    avatar whose photo happened to have this exact color relationship, see
    [[project_face_analysis_render_migration]]. A per-channel MAX can only
    ever be >= the old weighted-average value for the same two colors, so
    this is strictly more conservative (can only remove FEWER pixels as
    "background" than before, never more) -- same "belt and braces, no
    surprise regressions" posture as `_border_connected_removal_mask`'s own
    doc comment. Only removes background-colored pixels that are actually
    border-connected -- see `_border_connected_removal_mask`."""
    bg_solid = Image.new("RGB", image.size, background_rgb)
    diff_r, diff_g, diff_b = ImageChops.difference(image.convert("RGB"), bg_solid).split()
    diff_max = ImageChops.lighter(ImageChops.lighter(diff_r, diff_g), diff_b)
    candidate = diff_max.point(lambda v: 0 if v <= threshold else 255)
    return _border_connected_removal_mask(candidate)


# Supersample factor for `_face_oval_head_mask` below -- PIL's `polygon`
# fill has no antialiasing, and face_oval's ~36 sparse landmark points make a
# 1x-drawn edge visibly faceted at HEAD_RECT's 140px size (an ellipse's
# smooth curve hid the same lack of antialiasing far better). Draw at 4x,
# downsample with LANCZOS, same trick `head_crop` above already relies on
# for its own resize.
_HEAD_MASK_SUPERSAMPLE = 4


def _face_oval_head_mask(face_oval: list[Point], head_crop_box: tuple[float, float, float, float]) -> Image.Image | None:
    """The real per-photo face_oval contour (same landmark set `_draw_head`
    already draws for the parametric path -- see this module's own doc
    comment), remapped into head_crop's local HEAD_RECT-sized pixel space
    and stretched to fill it exactly like the plain circle this replaces
    used to. `None` when `face_oval` is empty (shouldn't happen once
    `palette.detected` is true, but this function has no independent
    guarantee of that -- see its own caller).

    Stretched rather than placed at its true remapped size/position because
    face_oval traces the jaw+forehead line ALONE, not hair -- a straight
    remap would crop away the hair margin `head_crop_box` was deliberately
    padded with (see `_FACE_PROTECTED_*` above's own doc comment on that
    margin). Rescaling face_oval's own bounding box to fill HEAD_RECT
    corner-to-corner (same coverage the old `ellipse((0, 2, 140, 138))` gave)
    keeps that same full coverage -- hair/ears outside the true jawline are
    included exactly as before -- while the shape itself is now this
    person's real tapered-chin, rounded-forehead proportions instead of a
    circle. Eyebrows/eyes/mouth are unaffected either way: those paste via
    their own crop_box/pivot math entirely independent of this mask."""
    if not face_oval:
        return None
    hx0, hy0, hx1, hy1 = head_crop_box
    crop_w, crop_h = max(1.0, hx1 - hx0), max(1.0, hy1 - hy0)
    local = [((x - hx0) / crop_w * HEAD_RECT["sWidth"], (y - hy0) / crop_h * HEAD_RECT["sHeight"]) for x, y in face_oval]
    xs, ys = [p[0] for p in local], [p[1] for p in local]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
    span_x, span_y = max(1e-6, max_x - min_x), max(1e-6, max_y - min_y)

    s = _HEAD_MASK_SUPERSAMPLE
    stretched = [
        ((x - min_x) / span_x * HEAD_RECT["sWidth"] * s, (2 + (y - min_y) / span_y * (HEAD_RECT["sHeight"] - 4)) * s)
        for x, y in local
    ]
    big_mask = Image.new("L", (HEAD_RECT["sWidth"] * s, HEAD_RECT["sHeight"] * s), 0)
    ImageDraw.Draw(big_mask).polygon(stretched, fill=255)
    return big_mask.resize((HEAD_RECT["sWidth"], HEAD_RECT["sHeight"]), Image.LANCZOS)


def build_atlas_png_from_photo(
    cartoon_image_bytes: bytes, palette: FacePalette
) -> tuple[
    bytes, dict[str, dict], tuple[float, float], tuple[float, float] | None, tuple[float, float] | None, tuple[float, float]
]:
    """The fal.ai-cartoonify path: crops the head and mouth directly out of
    `cartoon_image_bytes` (a real, if AI-stylized, photo -- see
    avatar_gen/cartoonify_provider.py) using `palette.head_crop_box`/
    `mouth_crop_box`/`background_rgb` (raw pixel coordinates for THESE exact
    bytes, computed by photo_analysis.py's `_compute_crop_regions` against
    the SAME image), rather than drawing a parametric cartoon head the way
    `build_atlas_png` above does. Requires `palette.detected` -- the caller

    Returns `(atlas_png_bytes, part_rects, mouth_pivot, eyebrows_pivot,
    eyes_pivot, neck_pivot)` -- the extra pivots (absent from
    `build_atlas_png`'s return above, since that path's feature positions are
    fixed by construction) are this specific avatar's own corrected
    "mouth"/"eyebrows"/"eyes"/"neck" part pivots from
    `_compute_photo_part_pivot`/`_compute_photo_neck_pivot`; the caller
    (service.py) must use them to override `_PARTS`' fixed pivots for this
    avatar's stored skin, or those parts render in the wrong place against
    this real photo's head. `eyebrows_pivot`/`eyes_pivot` are `None` (meaning
    "keep _PARTS' fixed pivot") only when `palette.eyebrow_crop_box`/
    `eye_crop_box` is itself `None` -- i.e. no eyebrow/eye contour was
    detected at all, same "nothing to correct against" posture as a missing
    mouth contour would need (mouth_crop_box is asserted non-None below since
    `palette.detected` already guarantees it, unlike these two which
    mediapipe could in principle still miss on a partially-obscured face).
    `neck_pivot`, unlike those two, is never `None` -- `_compute_photo_neck_pivot`
    always has a usable fallback (see its own doc comment) since leaving
    "neck" at `_PARTS`' fixed pivot is exactly the bug this exists to fix,
    not a safe default.
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
    head_shape_mask = _face_oval_head_mask(palette.face_oval, palette.head_crop_box)
    if head_shape_mask is None:
        head_shape_mask = Image.new("L", (HEAD_RECT["sWidth"], HEAD_RECT["sHeight"]), 0)
        ImageDraw.Draw(head_shape_mask).ellipse((0, 2, HEAD_RECT["sWidth"], HEAD_RECT["sHeight"] - 2), fill=255)

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
    # `_FACE_PROTECTED_TOP_FRACTION` is a "typical" guess (see its own doc
    # comment) that assumes the squared head crop needed no extra vertical
    # padding -- true whenever the RAW pre-hair-margin box is at least as
    # tall as it is wide, but a face proportion where that's not the case
    # (an unusually short raw box relative to the hair margin) can push the
    # real face top BELOW this guess, leaving a real forehead band outside
    # the protected ellipse -- reported as a semi-circular transparent patch
    # spanning the forehead, see [[project_avatar_face_top_protection_fix]].
    # `palette.head_top_fraction` is this exact photo's own measured
    # fraction (mirrors `head_chin_fraction`'s pattern below); take the
    # smaller (= more protective, since a lower fraction only ever grows the
    # protected region) of it and the fixed guess so a photo whose measured
    # fraction happens to be null or larger never loses today's baseline
    # protection.
    protected_top_fraction = _FACE_PROTECTED_TOP_FRACTION
    if palette.head_top_fraction is not None:
        protected_top_fraction = min(_FACE_PROTECTED_TOP_FRACTION, palette.head_top_fraction)
    protected_top = HEAD_RECT["sHeight"] * protected_top_fraction
    protected_bottom = HEAD_RECT["sHeight"] * _FACE_PROTECTED_BOTTOM_FRACTION
    ImageDraw.Draw(protected_mask).ellipse(
        (protected_cx - protected_half_w, protected_top, protected_cx + protected_half_w, protected_bottom), fill=255
    )

    bg_mask = _background_removal_mask(head_crop, palette.background_rgb).filter(ImageFilter.GaussianBlur(1.0))
    bg_mask = ImageChops.lighter(bg_mask, protected_mask)
    head_mask = ImageChops.multiply(head_shape_mask, bg_mask)

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
    # Teeth centered in the cavity (cy +/- 9) rather than hugging its top
    # edge -- the old (cy-8, cy-2) bbox sat almost flush against the
    # cavity's own top edge, which read as "teeth floating at the top of
    # the mouth" instead of a natural upper-teeth band.
    open_draw.ellipse((cx - 9, cy - 3, cx + 9, cy + 3), fill=_TEETH_COLOR)

    # "laugh" (mood override, never picked by word-driven lip-sync) -- taller
    # cavity than "open" (not flatter), same centered teeth band, plus a
    # same-color-as-gap stroke at each corner hooking up and back in toward
    # center, mirroring _draw_mouth_laugh's synthetic-path geometry so both
    # avatar paths read as an actual curled-up lip tip rather than a flat
    # oval with a diagonal crease.
    mouth_laugh = mouth_base.copy()
    laugh_draw = ImageDraw.Draw(mouth_laugh)
    laugh_draw.ellipse((cx - 15, cy - 10, cx + 15, cy + 10), fill=gap_color)
    for sign in (-1, 1):
        laugh_draw.line(
            [(cx + sign * 14, cy + 4), (cx + sign * 18, cy - 4), (cx + sign * 13, cy - 12)],
            fill=_OUTLINE_COLOR,
            width=3,
            joint="curve",
        )
    laugh_draw.ellipse((cx - 11, cy - 4, cx + 11, cy + 4), fill=_TEETH_COLOR)

    image = Image.new("RGBA", (CANVAS_WIDTH, CANVAS_HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    image.paste(head_crop.convert("RGBA"), (HEAD_RECT["sx"], HEAD_RECT["sy"]), head_mask)
    image.paste(mouth_closed.convert("RGBA"), (MOUTH_CLOSED_RECT["sx"], MOUTH_CLOSED_RECT["sy"]))
    image.paste(mouth_open.convert("RGBA"), (MOUTH_OPEN_RECT["sx"], MOUTH_OPEN_RECT["sy"]))
    image.paste(mouth_laugh.convert("RGBA"), (MOUTH_LAUGH_RECT["sx"], MOUTH_LAUGH_RECT["sy"]))
    mouth_pivot = _compute_photo_part_pivot(palette.head_crop_box, palette.mouth_crop_box, MOUTH_CLOSED_RECT)

    # UNLIKE build_atlas_png's fully-synthetic path above, this "head" IS a
    # real (cartoonified) photo crop that already shows this exact person's
    # own real eyebrows/eyes baked into its pixels. EYEBROWS_NEUTRAL_RECT and
    # EYES_OPEN_RECT are therefore left FULLY TRANSPARENT below whenever a
    # real contour was detected (the normal case) -- painting a synthetic
    # redraw on top of them (this function's old behavior, still correct for
    # build_atlas_png's plain drawn head, which has no real feature to defer
    # to) covered a correct, real feature with a cruder approximation that
    # never quite matched its real position/size/color, so the real one kept
    # visibly peeking out from behind it. That mismatch is worst exactly when
    # the eye "blinks": `_draw_closed_eye`'s bare line drew on top of an
    # otherwise-transparent layer, which never actually covered the
    # still-open real eye underneath -- so blinking looked like a stray dark
    # line crossing an eye that never closed. Passing `skin_tone` below fixes
    # that half by backing the same line/curve with an opaque patch (see
    # `_draw_closed_eye`/`_draw_mood_eyebrow`'s own doc comments -- this
    # patch deliberately follows each shape's own footprint rather than
    # flood-filling the whole rect, since a real pair of glasses can extend
    # into these same rects beyond the eye/eyebrow itself).
    # `_draw_face_features_layer`'s fallback (two dots for eyes, nothing for
    # eyebrows) only fires below on the rarer partially-obscured-face case
    # where mediapipe couldn't trace a contour at all -- there's no real
    # feature already visible then, so a generic synthetic one is better
    # than nothing.
    brow_color = palette.hair_tone or _DEFAULT_BROW_COLOR
    eyebrows_layer, eyes_layer = _draw_face_features_layer(
        image.size, palette.left_eye, palette.right_eye, palette.left_eyebrow, palette.right_eyebrow, palette.face_width_scale, brow_color
    )
    if not palette.eyebrow_crop_box:
        _paste_cropped_bbox(image, eyebrows_layer, EYEBROWS_NEUTRAL_RECT)
    if not palette.eye_crop_box:
        _paste_cropped_bbox(image, eyes_layer, EYES_OPEN_RECT)
    _draw_mood_eyebrow(image, EYEBROWS_ANGRY_RECT, "angry", brow_color, skin_tone=palette.skin_tone)
    _draw_mood_eyebrow(image, EYEBROWS_HAPPY_RECT, "happy", brow_color, skin_tone=palette.skin_tone)
    _draw_mood_eyebrow(image, EYEBROWS_SAD_RECT, "sad", brow_color, skin_tone=palette.skin_tone)
    _draw_closed_eye(draw, EYES_CLOSED_RECT, skin_tone=palette.skin_tone)
    eyebrows_pivot = (
        _compute_photo_part_pivot(palette.head_crop_box, palette.eyebrow_crop_box, EYEBROWS_NEUTRAL_RECT)
        if palette.eyebrow_crop_box
        else None
    )
    eyes_pivot = (
        _compute_photo_part_pivot(palette.head_crop_box, palette.eye_crop_box, EYES_OPEN_RECT) if palette.eye_crop_box else None
    )

    _torso_body(draw, TORSO_RECT)
    _rounded_rect(draw, ARM_L_RECT, inset=4, radius=14, fill=palette.skin_tone)
    _rounded_rect(draw, ARM_R_RECT, inset=4, radius=14, fill=palette.skin_tone)
    _rounded_rect(draw, FOREARM_L_RECT, inset=4, radius=13, fill=palette.skin_tone)
    _rounded_rect(draw, FOREARM_R_RECT, inset=4, radius=13, fill=palette.skin_tone)
    _rounded_rect(draw, LEG_L_RECT, inset=4, radius=17, fill=_PANTS_COLOR)
    _rounded_rect(draw, LEG_R_RECT, inset=4, radius=17, fill=_PANTS_COLOR)
    _draw_torso_polo(draw, POLO_RECT)
    _draw_torso_blazer(draw, BLAZER_RECT)
    _draw_torso_suit(draw, SUIT_RECT)
    _draw_neck(draw, NECK_RECT, palette.skin_tone)
    neck_pivot = _compute_photo_neck_pivot(palette.head_chin_fraction)
    _draw_hand_open(draw, HAND_L_OPEN_RECT, palette.skin_tone)
    _draw_hand_fist(draw, HAND_L_FIST_RECT, palette.skin_tone)
    _draw_hand_pointing(draw, HAND_L_POINT_RECT, palette.skin_tone)
    _draw_hand_open(draw, HAND_R_OPEN_RECT, palette.skin_tone)
    _draw_hand_fist(draw, HAND_R_FIST_RECT, palette.skin_tone)
    _draw_hand_pointing(draw, HAND_R_POINT_RECT, palette.skin_tone)
    # TORSO_TRIM_BASE_RECT is left blank on purpose -- a plain shirt has no
    # trim accent (see its own doc comment above).
    _draw_torso_trim_polo(draw, TORSO_TRIM_POLO_RECT, _TRIM_COLOR)
    _draw_torso_trim_blazer(draw, TORSO_TRIM_BLAZER_RECT, _TRIM_COLOR)
    _draw_torso_trim_suit(draw, TORSO_TRIM_SUIT_RECT, _TRIM_COLOR)

    buffer = BytesIO()
    image.save(buffer, format="PNG")

    part_rects = {
        "head": HEAD_RECT,
        "mouth": MOUTH_CLOSED_RECT,
        "closed": MOUTH_CLOSED_RECT,
        "open": MOUTH_OPEN_RECT,
        "laughOpen": MOUTH_LAUGH_RECT,
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
        "forearmL": FOREARM_L_RECT,
        "forearmR": FOREARM_R_RECT,
        "legL": LEG_L_RECT,
        "legR": LEG_R_RECT,
        "polo": POLO_RECT,
        "blazer": BLAZER_RECT,
        "suit": SUIT_RECT,
        "neck": NECK_RECT,
        "handL": HAND_L_OPEN_RECT,
        "handR": HAND_R_OPEN_RECT,
        "handLFist": HAND_L_FIST_RECT,
        "handLPoint": HAND_L_POINT_RECT,
        "handRFist": HAND_R_FIST_RECT,
        "handRPoint": HAND_R_POINT_RECT,
        "torsoTrim": TORSO_TRIM_BASE_RECT,
        "torsoTrim::polo": TORSO_TRIM_POLO_RECT,
        "torsoTrim::blazer": TORSO_TRIM_BLAZER_RECT,
        "torsoTrim::suit": TORSO_TRIM_SUIT_RECT,
    }
    return buffer.getvalue(), part_rects, mouth_pivot, eyebrows_pivot, eyes_pivot, neck_pivot
