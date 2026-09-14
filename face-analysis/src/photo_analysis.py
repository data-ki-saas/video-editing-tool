"""Face-photo -> avatar-palette extraction, the Python-side mirror of
frontend/src/lib/video/faceLandmarks.ts's browser-side MediaPipe use (see
that file's own doc comment) -- but run once, server-side, against an
uploaded photo rather than live video. Uses mediapipe's Tasks API
`FaceLandmarker` against the same 468/478-point face mesh topology
faceLandmarks.ts already uses, so the same landmark indices apply.

Lives in its own Cloud Run (GPU) service, not backend/ -- Render's native
Python runtime has no apt/root access to install the Mesa/GLES system
libraries mediapipe's compiled bindings need (`libGLESv2.so.2` et al), so
this moved out to a container we control end-to-end. backend/src/avatar_gen/
photo_analysis.py is now a thin HTTP client calling this service; this file
is the real implementation, otherwise unchanged from its original in-process
form.

Deliberately NOT an LLM call (see the avatar plan doc's own note that Phase
6 is "deterministic landmark -> template mapping") -- this is pure
computer-vision heuristics feeding a parametric template (atlas_builder.py,
still in backend/, since it has no mediapipe/native dependency of its own),
not generative synthesis.
"""

from __future__ import annotations

import logging
import tempfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Literal

import httpx
from PIL import Image

from src.config import settings

FaceShape = Literal["oval", "round", "wide"]
HairLength = Literal["bald", "short", "medium", "long"]

logger = logging.getLogger(__name__)

# Google's official MediaPipe Tasks model bundle -- same model the legacy
# `mediapipe.solutions.face_mesh` API used internally, just no longer
# bundled inside the pip wheel itself.
_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
_MODEL_CACHE_PATH = Path(tempfile.gettempdir()) / "reel_creator_face_landmarker.task"

# Same landmark indices as frontend/src/lib/video/faceLandmarks.ts's LM_*
# constants -- both run against the same face mesh topology.
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

# A typical cheek-width/face-height ratio (see FacePalette.face_width_scale's
# own comment) -- the neutral point face_width_scale=1.0 is calibrated
# around, not a literal measurement of any specific face.
_TYPICAL_FACE_ASPECT = 0.75
# How strongly a measured aspect away from _TYPICAL_FACE_ASPECT moves
# face_width_scale, clamped into a subtle, never-grotesque range -- this is
# a cartoon template accent, not a precise reconstruction.
_FACE_WIDTH_SCALE_MIN = 0.88
_FACE_WIDTH_SCALE_MAX = 1.12
# Same cheek-width/face-height aspect used for face_width_scale, but bucketed
# into a discrete outline STYLE (atlas_builder.py draws a genuinely different
# silhouette per bucket -- an oval, a soft round circle, or a wider rounded-
# rectangle jaw) rather than only stretching one ellipse. A deadband around
# _TYPICAL_FACE_ASPECT keeps an average face solidly "round" instead of
# flip-flopping between buckets on measurement noise.
_FACE_SHAPE_DEADBAND = 0.05

_PATCH_HALF_SIZE = 6

# Hair-length estimation: sample points progressively further below the chin
# (same hairline->chin extrapolation direction as the existing top-of-head
# hair sample) and count how many still look hair-colored. No hair/body
# segmentation model involved -- this is a cheap heuristic, not a precise
# measurement (same "informal, human judgment, no similarity metric" posture
# as the rest of this file), and a real risk is a dark background behind the
# subject getting mistaken for long hair. Fails toward "short" (the least
# visually committal bucket) when the signal is weak/ambiguous rather than
# confidently guessing "long."
_HAIR_SAMPLE_STEPS: tuple[float, ...] = (0.3, 0.7, 1.1)
_HAIR_COLOR_MATCH_DISTANCE = 40.0


@dataclass
class FacePalette:
    skin_tone: str
    hair_tone: str | None
    detected: bool
    # A ready-to-multiply horizontal head-width scale (1.0 = neutral/default)
    # -- derived from cheek-width DIVIDED BY hairline-to-chin height (a
    # ratio internal to the face itself), not raw cheek-to-cheek pixel width
    # alone. Raw width would mostly measure how zoomed-in/far-away the photo
    # is, not the face's actual shape, since a close-up selfie and a
    # far-away photo of the same person produce wildly different pixel
    # widths -- the height-normalized ratio is framing-invariant, so a
    # narrow-vs-round face reads consistently regardless of photo framing.
    face_width_scale: float = 1.0
    # Discrete outline style, see _FACE_SHAPE_DEADBAND's own comment.
    face_shape: FaceShape = "round"
    # Discrete hair-coverage bucket, see _HAIR_SAMPLE_STEPS's own comment.
    # "bald" only ever comes from hair_tone being None (no hair sample at
    # all), never from the length heuristic itself.
    hair_length: HairLength = "short"


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

        # This service is deployed on an NVIDIA L4 Cloud Run instance
        # specifically so this can run on the GPU delegate -- but mediapipe's
        # Linux GPU delegate support is narrower than its mobile (Android/
        # iOS) support and hasn't been exercised on real hardware from this
        # dev environment (no GPU available here). Try GPU first, fall back
        # to CPU on ANY construction/detection failure rather than assume it
        # works -- verify against real Cloud Run logs after deploying, and
        # flip settings.face_analysis_use_gpu off if the GPU delegate proves
        # unreliable rather than fighting it.
        landmarker_cm = None
        result = None
        if settings.face_analysis_use_gpu:
            try:
                landmarker_cm = _create_landmarker(model_path, use_gpu=True)
                with landmarker_cm as landmarker:
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

        def point(index: int) -> tuple[float, float]:
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
            # Linear around the neutral point, clamped to a subtle range --
            # see this file's own _FACE_WIDTH_SCALE_MIN/MAX comment.
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

        return FacePalette(
            skin_tone=skin_tone,
            hair_tone=hair_tone,
            detected=True,
            face_width_scale=face_width_scale,
            face_shape=face_shape,
            hair_length=hair_length,
        )
    except Exception:
        logger.exception("face photo analysis failed; falling back to default proportions")
        return FacePalette(skin_tone=_DEFAULT_SKIN_TONE, hair_tone=None, detected=False)
