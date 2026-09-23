"""Thin HTTP client for the standalone `face-analysis/` service (Render,
Docker-deployed -- see [[project_face_analysis_render_migration]]) -- the
actual mediapipe FaceLandmarker analysis used to run in-process here, but
Render's native Python runtime has no apt/root access to install the
Mesa/GLES/EGL system libraries mediapipe's compiled bindings need, which made
every photo analysis on Render silently fail and fall back to defaults --
see [[project_avatar_phase6_photo_gen]] for the incident this fixes.
face-analysis/src/photo_analysis.py is the real implementation (moved,
otherwise unchanged in shape); this file preserves the exact same call
signature and fallback contract so avatar_gen/service.py needs no changes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Literal

import httpx

from src.core.config import settings

logger = logging.getLogger(__name__)

# Render's free tier scales this service to zero between requests -- a cold
# start (container boot + mediapipe model load) can comfortably exceed 20s,
# which showed up as every avatar_gen.service.rebake_all_avatars bulk run
# reliably timing out on the FIRST record only (the one paying the cold-start
# cost) while the rest, hitting the now-warm instance, succeeded in ~1s each.
# 60s is a generous buffer for that specific cold path without meaningfully
# changing the experience of the normal warm-instance case (see
# [[project_face_analysis_render_migration]]) -- this fails toward the exact
# same silent default-proportions fallback either way, just gives a cold
# start enough runway to not need it.
_TIMEOUT_SECONDS = 60.0

FaceShape = Literal["oval", "round", "wide"]
HairLength = Literal["bald", "short", "medium", "long"]
Point = tuple[float, float]
Box = tuple[float, float, float, float]


@dataclass
class FacePalette:
    skin_tone: str
    hair_tone: str | None
    detected: bool
    face_width_scale: float = 1.0
    face_shape: FaceShape = "round"
    hair_length: HairLength = "short"
    face_oval: list[Point] = field(default_factory=list)
    left_eye: list[Point] = field(default_factory=list)
    right_eye: list[Point] = field(default_factory=list)
    left_eyebrow: list[Point] = field(default_factory=list)
    right_eyebrow: list[Point] = field(default_factory=list)
    mouth_width_scale: float = 1.0
    nose_width_scale: float = 1.0
    nose_center: Point = (0.0, 0.0)
    # Raw pixel-space crop boxes for the exact image bytes just analyzed --
    # used by the fal.ai-cartoonify photo-avatar path (avatar_gen/service.py)
    # to crop the head/mouth directly out of real image bytes, not draw them.
    # None whenever detected=False.
    head_crop_box: Box | None = None
    mouth_crop_box: Box | None = None
    eyebrow_crop_box: Box | None = None
    eye_crop_box: Box | None = None
    background_rgb: tuple[int, int, int] | None = None
    # Chin's position as a fraction of head_crop_box's own height -- see
    # face-analysis/src/photo_analysis.py's FacePalette.head_chin_fraction
    # for why this isn't always ~1.0. Feeds atlas_builder.py's per-photo
    # "neck" pivot the same way mouth_crop_box/eyebrow_crop_box/eye_crop_box
    # feed the mouth/eyebrows/eyes pivots.
    head_chin_fraction: float | None = None
    # Same idea, top edge -- see face-analysis/src/photo_analysis.py's
    # FacePalette.head_top_fraction. Feeds atlas_builder.py's per-photo
    # forehead chroma-key protection instead of a fixed fraction guess.
    head_top_fraction: float | None = None


_DEFAULT_SKIN_TONE = "#e8b48c"


def analyze_photo(photo_bytes: bytes) -> FacePalette:
    """Fails toward `FacePalette(detected=False)` on ANY error -- an
    unreachable service, a timeout, or a non-200 response shouldn't fail the
    whole generation, same contract this function has always had. See
    face-analysis/src/photo_analysis.py's own docstring for the real
    detection logic."""
    if not settings.face_analysis_service_url:
        logger.error("FACE_ANALYSIS_SERVICE_URL is not configured; using default proportions")
        return FacePalette(skin_tone=_DEFAULT_SKIN_TONE, hair_tone=None, detected=False)

    try:
        response = httpx.post(
            f"{settings.face_analysis_service_url}/analyze",
            files={"file": ("photo.jpg", photo_bytes, "application/octet-stream")},
            headers={"x-internal-secret": settings.face_analysis_service_secret},
            timeout=_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        body = response.json()
        return FacePalette(
            skin_tone=body["skin_tone"],
            hair_tone=body["hair_tone"],
            detected=body["detected"],
            face_width_scale=body["face_width_scale"],
            face_shape=body["face_shape"],
            hair_length=body["hair_length"],
            face_oval=[tuple(p) for p in body["face_oval"]],
            left_eye=[tuple(p) for p in body["left_eye"]],
            right_eye=[tuple(p) for p in body["right_eye"]],
            left_eyebrow=[tuple(p) for p in body["left_eyebrow"]],
            right_eyebrow=[tuple(p) for p in body["right_eyebrow"]],
            mouth_width_scale=body["mouth_width_scale"],
            nose_width_scale=body["nose_width_scale"],
            nose_center=tuple(body["nose_center"]),
            head_crop_box=tuple(body["head_crop_box"]) if body.get("head_crop_box") else None,
            mouth_crop_box=tuple(body["mouth_crop_box"]) if body.get("mouth_crop_box") else None,
            eyebrow_crop_box=tuple(body["eyebrow_crop_box"]) if body.get("eyebrow_crop_box") else None,
            eye_crop_box=tuple(body["eye_crop_box"]) if body.get("eye_crop_box") else None,
            background_rgb=tuple(body["background_rgb"]) if body.get("background_rgb") else None,
            head_chin_fraction=body.get("head_chin_fraction"),
            head_top_fraction=body.get("head_top_fraction"),
        )
    except Exception:
        logger.exception("face-analysis service call failed; falling back to default proportions")
        return FacePalette(skin_tone=_DEFAULT_SKIN_TONE, hair_tone=None, detected=False)
