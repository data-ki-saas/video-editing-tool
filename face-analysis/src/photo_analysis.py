"""Face-photo -> avatar-palette extraction, the Python-side mirror of
frontend/src/lib/video/faceLandmarks.ts's browser-side MediaPipe use (see
that file's own doc comment) -- but run once, server-side, against an
uploaded photo rather than live video. Uses mediapipe's Tasks API
`FaceLandmarker` against the same 468/478-point face mesh topology
faceLandmarks.ts already uses, so the same landmark indices apply.

Lives in its own Cloud Run service, not backend/ -- Render's native Python
runtime has no apt/root access to install the Mesa/GLES/EGL system libraries
mediapipe's compiled bindings need, so this moved out to a container we
control end-to-end. backend/src/avatar_gen/photo_analysis.py is now a thin
HTTP client calling this service; this file is the real implementation.

Deliberately NOT an LLM call, and NOT a generative image model (see the
avatar plan doc's own note that Phase 6 is "deterministic landmark ->
template mapping") -- this is pure computer-vision heuristics feeding a
parametric template (atlas_builder.py, still in backend/, since it has no
mediapipe/native dependency of its own).

What this extracts, and why it stops here: mediapipe's face mesh returns 468
points total. ~152 of them are CONTOUR/BOUNDARY points for named features
(face outline, both eyes, both eyebrows, lips, nose) -- this file extracts
essentially all of those, via mediapipe's own published
`FaceLandmarksConnections` groups (imported directly from the installed
package and graph-traced into ordered point loops/chains at import time --
see `_trace`/`_face_landmark_groups` below -- NOT hand-typed index numbers,
after an earlier landmark-index mixup elsewhere in this project). The
remaining ~316 points are dense interior TESSELLATION for 3D surface
curvature (cheek/forehead bulge, etc.) -- meaningful for a shaded 3D mesh,
meaningless for the flat 2D cartoon silhouettes atlas_builder.py draws, so
they're not used here; using them for real would mean building an actual
shaded 3D face, a different product direction than this one.
"""

from __future__ import annotations

import logging
import tempfile
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Literal

import httpx
from PIL import Image

from src.config import settings

FaceShape = Literal["oval", "round", "wide"]
HairLength = Literal["bald", "short", "medium", "long"]
Point = tuple[float, float]

logger = logging.getLogger(__name__)

# Google's official MediaPipe Tasks model bundle -- same model the legacy
# `mediapipe.solutions.face_mesh` API used internally, just no longer
# bundled inside the pip wheel itself.
_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
_MODEL_CACHE_PATH = Path(tempfile.gettempdir()) / "reel_creator_face_landmarker.task"

# Same landmark indices as frontend/src/lib/video/faceLandmarks.ts's LM_*
# constants -- both run against the same face mesh topology. Also the
# normalization anchors for every contour extracted below (see `_normalize`).
_LM_HAIRLINE_CENTER = 10
_LM_CHIN = 152
_LM_LEFT_CHEEK = 234
_LM_RIGHT_CHEEK = 454

# Matches placeholderAtlas.ts's own SKIN_TONE default -- a face-detection
# miss should still produce a recognizably "on brand" placeholder tone rather
# than an arbitrary one.
_DEFAULT_SKIN_TONE = "#e8b48c"

# Matches faceLandmarks.ts's own TOP_OF_HEAD_EXTRAPOLATION_FACTOR -- there's
# no literal top-of-head landmark in the mesh, so it's extrapolated along the
# hairline->chin vector the same way that file already does.
_TOP_OF_HEAD_EXTRAPOLATION_FACTOR = 0.55

# A typical cheek-width/face-height ratio -- kept as a FALLBACK signal for
# when no face_oval contour is available (detected=False), and to seed
# face_width_scale/face_shape for backward compatibility. Once a real
# face_oval polygon is present, atlas_builder.py prefers that over these.
_TYPICAL_FACE_ASPECT = 0.75
_FACE_WIDTH_SCALE_MIN = 0.88
_FACE_WIDTH_SCALE_MAX = 1.12
_FACE_SHAPE_DEADBAND = 0.05

_PATCH_HALF_SIZE = 6

# Hair-length estimation: sample points progressively further below the chin
# (same hairline->chin extrapolation direction as the existing top-of-head
# hair sample) and count how many still look hair-colored. No hair/body
# segmentation model involved -- this is a cheap heuristic, not a precise
# measurement, and a real risk is a dark background behind the subject
# getting mistaken for long hair. Fails toward "short" (the least visually
# committal bucket) when the signal is weak/ambiguous rather than
# confidently guessing "long."
_HAIR_SAMPLE_STEPS: tuple[float, ...] = (0.3, 0.7, 1.1)
_HAIR_COLOR_MATCH_DISTANCE = 40.0

# Neutral mouth-width reference (as a fraction of face_height) --
# mouth_width_scale=1.0 is calibrated around this, same "deadband around a
# typical ratio" pattern as _TYPICAL_FACE_ASPECT.
_TYPICAL_MOUTH_WIDTH_RATIO = 0.38
_TYPICAL_NOSE_WIDTH_RATIO = 0.22


@dataclass
class FacePalette:
    skin_tone: str
    hair_tone: str | None
    detected: bool
    # Legacy scalar/bucket signals -- still computed (cheap, harmless) as
    # the fallback path's driver when no contour is available. See each
    # field's own history: face_width_scale/face_shape were the ONLY shape
    # signal before face_oval existed.
    face_width_scale: float = 1.0
    face_shape: FaceShape = "round"
    hair_length: HairLength = "short"
    # Real per-person contours, normalized to face-relative units (origin =
    # hairline/chin midpoint, unit = hairline-to-chin distance, same
    # reference frame face_width_scale always used -- see `_normalize`).
    # atlas_builder.py remaps these into actual atlas pixel coordinates; this
    # module never draws anything itself. Empty whenever detected=False.
    face_oval: list[Point] = field(default_factory=list)  # 36 pts, closed polygon
    left_eye: list[Point] = field(default_factory=list)  # 16 pts, closed polygon
    right_eye: list[Point] = field(default_factory=list)  # 16 pts, closed polygon
    left_eyebrow: list[Point] = field(default_factory=list)  # 5 pts, open arc
    right_eyebrow: list[Point] = field(default_factory=list)  # 5 pts, open arc
    mouth_width_scale: float = 1.0  # from the 20-pt outer-lips contour's width
    nose_width_scale: float = 1.0  # from the 24-pt nose region's width
    nose_center: Point = (0.0, 0.0)  # from the 24-pt nose region's centroid


def _ensure_model() -> Path:
    """Downloads the FaceLandmarker model bundle to a process-wide temp
    cache on first use; later calls (in this process, or the next one on the
    same host) reuse the cached file instead of re-downloading. Raises on
    any failure -- analyze_photo's own try/except is what turns that into a
    graceful default-palette fallback, not this function."""
    if _MODEL_CACHE_PATH.exists() and _MODEL_CACHE_PATH.stat().st_size > 0:
        return _MODEL_CACHE_PATH
    with httpx.Client(timeout=30) as client:
        response = client.get(_MODEL_URL)
        response.raise_for_status()
    _MODEL_CACHE_PATH.write_bytes(response.content)
    return _MODEL_CACHE_PATH


def _to_hex(rgb: tuple[float, float, float]) -> str:
    r, g, b = (max(0, min(255, round(c))) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def _hex_to_rgb(color: str) -> tuple[int, int, int]:
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def _color_distance(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


def _average_patch_color(pixels, width: int, height: int, cx: float, cy: float) -> tuple[float, float, float] | None:
    """Average RGB over a small square patch centered at (cx, cy) -- cheap
    stand-in for a real skin/hair segmentation model, adequate for a
    cartoon-template's recolor since exact pixel accuracy was never the
    goal (see this feature's own plan doc: "informal, human judgment", no
    similarity metric planned)."""
    x0, x1 = int(max(0, cx - _PATCH_HALF_SIZE)), int(min(width, cx + _PATCH_HALF_SIZE))
    y0, y1 = int(max(0, cy - _PATCH_HALF_SIZE)), int(min(height, cy + _PATCH_HALF_SIZE))
    if x1 <= x0 or y1 <= y0:
        return None
    total_r = total_g = total_b = 0
    count = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = pixels[x, y]
            total_r += r
            total_g += g
            total_b += b
            count += 1
    if count == 0:
        return None
    return total_r / count, total_g / count, total_b / count


def _estimate_hair_length(
    pixels, width: int, height: int, hairline: tuple[float, float], chin: tuple[float, float], hair_tone: str
) -> HairLength:
    """Extends the hairline->chin vector further past the chin (toward where
    shoulders would be in a typical portrait) and checks how many of those
    points still look hair-colored -- more matches, further down, means
    longer hair. See this file's own _HAIR_SAMPLE_STEPS comment for the
    accepted false-positive risk (a hair-toned background)."""
    dx, dy = chin[0] - hairline[0], chin[1] - hairline[1]
    target = _hex_to_rgb(hair_tone)
    matches = 0
    for t in _HAIR_SAMPLE_STEPS:
        sample = _average_patch_color(pixels, width, height, chin[0] + dx * t, chin[1] + dy * t)
        if sample is not None and _color_distance(sample, target) < _HAIR_COLOR_MATCH_DISTANCE:
            matches += 1
    if matches >= len(_HAIR_SAMPLE_STEPS):
        return "long"
    if matches >= 1:
        return "medium"
    return "short"


def _trace(connections) -> list[int]:
    """Traces mediapipe's own published FaceLandmarksConnections edge list
    into a single ordered point sequence -- verified against the installed
    package directly at import time (see `_face_landmark_groups`), not
    hand-typed indices. Every contour used here (face oval, one eye, outer
    lips) is a simple cycle where each point has degree 2 in the undirected
    edge graph, so a greedy "follow any not-yet-used edge" walk traces the
    full loop back to its start; an eyebrow arc is the same walk over an
    OPEN chain, which just runs out of edges without closing."""
    adjacency: dict[int, list[int]] = {}
    edges = set()
    for c in connections:
        adjacency.setdefault(c.start, []).append(c.end)
        adjacency.setdefault(c.end, []).append(c.start)
        edges.add(frozenset((c.start, c.end)))
    start = connections[0].start
    order = [start]
    used: set[frozenset[int]] = set()
    current = start
    while len(used) < len(edges):
        next_point = next(
            (candidate for candidate in adjacency[current] if frozenset((current, candidate)) not in used), None
        )
        if next_point is None:
            break
        used.add(frozenset((current, next_point)))
        if next_point != start:
            order.append(next_point)
        current = next_point
    return order


def _component_containing(connections, point: int) -> list:
    """Lips is two disconnected loops (outer + inner contour) inside one
    connection list -- this isolates whichever one contains `point` (61 is a
    well-known outer-lip corner) so `_trace` only walks that one."""
    adjacency: dict[int, set[int]] = {}
    for c in connections:
        adjacency.setdefault(c.start, set()).add(c.end)
        adjacency.setdefault(c.end, set()).add(c.start)
    stack, component = [point], {point}
    while stack:
        node = stack.pop()
        for neighbor in adjacency.get(node, ()):
            if neighbor not in component:
                component.add(neighbor)
                stack.append(neighbor)
    return [c for c in connections if c.start in component and c.end in component]


_face_landmark_groups_cache: dict[str, list[int]] | None = None


def _face_landmark_groups() -> dict[str, list[int]]:
    """Ordered landmark-index lists per facial feature, computed once (not
    per-request) from mediapipe's own installed FaceLandmarksConnections.
    Deferred import (not module-scope) so this file still imports cleanly
    anywhere mediapipe itself isn't installed (e.g. a future test file)."""
    global _face_landmark_groups_cache
    if _face_landmark_groups_cache is not None:
        return _face_landmark_groups_cache

    from mediapipe.tasks.python.vision.face_landmarker import FaceLandmarksConnections as C

    outer_lips = _component_containing(C.FACE_LANDMARKS_LIPS, 61)
    nose_points = sorted({c.start for c in C.FACE_LANDMARKS_NOSE} | {c.end for c in C.FACE_LANDMARKS_NOSE})
    _face_landmark_groups_cache = {
        "face_oval": _trace(C.FACE_LANDMARKS_FACE_OVAL),
        "left_eye": _trace(C.FACE_LANDMARKS_LEFT_EYE),
        "right_eye": _trace(C.FACE_LANDMARKS_RIGHT_EYE),
        "left_eyebrow": _trace(C.FACE_LANDMARKS_LEFT_EYEBROW),
        "right_eyebrow": _trace(C.FACE_LANDMARKS_RIGHT_EYEBROW),
        "outer_lips": _trace(outer_lips),
        "nose": nose_points,
    }
    return _face_landmark_groups_cache


def _create_landmarker(model_path: Path, use_gpu: bool):
    from mediapipe.tasks.python.core.base_options import BaseOptions
    from mediapipe.tasks.python.vision import FaceLandmarker, FaceLandmarkerOptions

    delegate = BaseOptions.Delegate.GPU if use_gpu else BaseOptions.Delegate.CPU
    options = FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path), delegate=delegate), num_faces=1
    )
    return FaceLandmarker.create_from_options(options)


def analyze_photo(photo_bytes: bytes) -> FacePalette:
    """Fails toward `FacePalette(detected=False)` on ANY error -- a face
    photo shouldn't fail the whole generation just because a face wasn't
    detected or mediapipe itself hiccuped; the atlas builder still produces
    a usable (if generic-toned) avatar either way. Same contract as this
    file's original in-process version in backend/ -- see this file's own
    module doc comment for why it now lives here instead."""
    try:
        import numpy as np
        from mediapipe import Image as MpImage, ImageFormat

        model_path = _ensure_model()

        image = Image.open(BytesIO(photo_bytes)).convert("RGB")
        width, height = image.size
        pixels = image.load()

        mp_image = MpImage(image_format=ImageFormat.SRGB, data=np.asarray(image))

        # Try the GPU delegate first, fall back to CPU on ANY construction/
        # detection failure rather than assume it works -- mediapipe's Linux
        # GPU delegate support is narrower than mobile, and this has never
        # run on real GPU hardware from this dev environment. Off by default
        # (settings.face_analysis_use_gpu) -- this service dropped its GPU
        # after a Cloud Run quota wall; see project memory.
        result = None
        if settings.face_analysis_use_gpu:
            try:
                with _create_landmarker(model_path, use_gpu=True) as landmarker:
                    result = landmarker.detect(mp_image)
            except Exception:
                logger.exception("GPU delegate failed, falling back to CPU delegate for this request")
                result = None
        if result is None:
            with _create_landmarker(model_path, use_gpu=False) as landmarker:
                result = landmarker.detect(mp_image)

        if not result.face_landmarks:
            return FacePalette(skin_tone=_DEFAULT_SKIN_TONE, hair_tone=None, detected=False)

        landmarks = result.face_landmarks[0]

        def point(index: int) -> Point:
            lm = landmarks[index]
            return lm.x * width, lm.y * height

        left_cheek = point(_LM_LEFT_CHEEK)
        right_cheek = point(_LM_RIGHT_CHEEK)
        hairline = point(_LM_HAIRLINE_CENTER)
        chin = point(_LM_CHIN)

        cheek_mid = ((left_cheek[0] + right_cheek[0]) / 2, (left_cheek[1] + right_cheek[1]) / 2)
        skin_sample = _average_patch_color(pixels, width, height, *cheek_mid)
        skin_tone = _to_hex(skin_sample) if skin_sample is not None else _DEFAULT_SKIN_TONE

        # Extrapolated top-of-head, then a further small step past it so the
        # sample patch lands in hair/scalp rather than forehead skin -- same
        # vector faceLandmarks.ts already extrapolates along.
        top_of_head = (
            hairline[0] + (hairline[0] - chin[0]) * _TOP_OF_HEAD_EXTRAPOLATION_FACTOR,
            hairline[1] + (hairline[1] - chin[1]) * _TOP_OF_HEAD_EXTRAPOLATION_FACTOR,
        )
        hair_sample_point = (
            top_of_head[0],
            top_of_head[1] - (hairline[1] - top_of_head[1]) * 0.4 - _PATCH_HALF_SIZE,
        )
        hair_sample = _average_patch_color(pixels, width, height, *hair_sample_point)
        hair_tone = _to_hex(hair_sample) if hair_sample is not None else None

        cheek_width = ((left_cheek[0] - right_cheek[0]) ** 2 + (left_cheek[1] - right_cheek[1]) ** 2) ** 0.5
        face_height = ((hairline[0] - chin[0]) ** 2 + (hairline[1] - chin[1]) ** 2) ** 0.5
        face_width_scale = 1.0
        face_shape: FaceShape = "round"
        if face_height > 0:
            aspect = cheek_width / face_height
            face_width_scale = max(
                _FACE_WIDTH_SCALE_MIN, min(_FACE_WIDTH_SCALE_MAX, 1.0 + (aspect - _TYPICAL_FACE_ASPECT))
            )
            if aspect < _TYPICAL_FACE_ASPECT - _FACE_SHAPE_DEADBAND:
                face_shape = "oval"
            elif aspect > _TYPICAL_FACE_ASPECT + _FACE_SHAPE_DEADBAND:
                face_shape = "wide"

        hair_length: HairLength = "bald"
        if hair_tone is not None:
            hair_length = _estimate_hair_length(pixels, width, height, hairline, chin, hair_tone)

        # Face-relative normalization: origin at the hairline/chin midpoint,
        # unit = hairline-to-chin distance -- the SAME reference frame
        # face_width_scale has always used, just applied to every contour
        # point instead of two scalar distances. Framing-invariant (a
        # close-up selfie and a far-away photo of the same person normalize
        # to the same shape) for the same reason the original comment on
        # face_width_scale gave.
        origin = ((hairline[0] + chin[0]) / 2, (hairline[1] + chin[1]) / 2)
        scale = face_height if face_height > 0 else 1.0

        def normalize(index: int) -> Point:
            px, py = point(index)
            return (px - origin[0]) / scale, (py - origin[1]) / scale

        groups = _face_landmark_groups()
        face_oval = [normalize(i) for i in groups["face_oval"]]
        left_eye = [normalize(i) for i in groups["left_eye"]]
        right_eye = [normalize(i) for i in groups["right_eye"]]
        left_eyebrow = [normalize(i) for i in groups["left_eyebrow"]]
        right_eyebrow = [normalize(i) for i in groups["right_eyebrow"]]

        outer_lips_raw = [point(i) for i in groups["outer_lips"]]
        lips_xs = [p[0] for p in outer_lips_raw]
        mouth_width_px = max(lips_xs) - min(lips_xs)
        mouth_width_ratio = mouth_width_px / face_height if face_height > 0 else _TYPICAL_MOUTH_WIDTH_RATIO
        mouth_width_scale = mouth_width_ratio / _TYPICAL_MOUTH_WIDTH_RATIO if _TYPICAL_MOUTH_WIDTH_RATIO > 0 else 1.0

        nose_raw = [point(i) for i in groups["nose"]]
        nose_xs = [p[0] for p in nose_raw]
        nose_width_px = max(nose_xs) - min(nose_xs)
        nose_width_ratio = nose_width_px / face_height if face_height > 0 else _TYPICAL_NOSE_WIDTH_RATIO
        nose_width_scale = nose_width_ratio / _TYPICAL_NOSE_WIDTH_RATIO if _TYPICAL_NOSE_WIDTH_RATIO > 0 else 1.0
        nose_center_raw = (sum(p[0] for p in nose_raw) / len(nose_raw), sum(p[1] for p in nose_raw) / len(nose_raw))
        nose_center = ((nose_center_raw[0] - origin[0]) / scale, (nose_center_raw[1] - origin[1]) / scale)

        return FacePalette(
            skin_tone=skin_tone,
            hair_tone=hair_tone,
            detected=True,
            face_width_scale=face_width_scale,
            face_shape=face_shape,
            hair_length=hair_length,
            face_oval=face_oval,
            left_eye=left_eye,
            right_eye=right_eye,
            left_eyebrow=left_eyebrow,
            right_eyebrow=right_eyebrow,
            mouth_width_scale=max(0.7, min(1.4, mouth_width_scale)),
            nose_width_scale=max(0.7, min(1.4, nose_width_scale)),
            nose_center=nose_center,
        )
    except Exception:
        logger.exception("face photo analysis failed; falling back to default proportions")
        return FacePalette(skin_tone=_DEFAULT_SKIN_TONE, hair_tone=None, detected=False)
