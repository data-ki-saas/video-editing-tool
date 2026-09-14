"""Thin HTTP client for the standalone `face-analysis/` Cloud Run service --
the actual mediapipe FaceLandmarker analysis used to run in-process here,
but Render's native Python runtime has no apt/root access to install the
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

_TIMEOUT_SECONDS = 20.0

FaceShape = Literal["oval", "round", "wide"]
HairLength = Literal["bald", "short", "medium", "long"]
Point = tuple[float, float]


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
        # TEMPORARY diagnostic -- a real-photo test rendered with invisible
        # eyes/nose and no obvious bug found by code review; logs the wire
        # response's actual shape so it's visible in Render's own logs
        # (mirrors a similar log on the face-analysis/ side of this same
        # call). Remove once the eyes/nose rendering is confirmed fixed.
        logger.info(
            "face-analysis response: detected=%s face_oval_n=%d left_eye_n=%d right_eye_n=%d "
            "left_eyebrow_n=%d mouth_width_scale=%s nose_width_scale=%s nose_center=%s",
            body.get("detected"),
            len(body.get("face_oval") or []),
            len(body.get("left_eye") or []),
            len(body.get("right_eye") or []),
            len(body.get("left_eyebrow") or []),
            body.get("mouth_width_scale"),
            body.get("nose_width_scale"),
            body.get("nose_center"),
        )
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
        )
    except Exception:
        logger.exception("face-analysis service call failed; falling back to default proportions")
        return FacePalette(skin_tone=_DEFAULT_SKIN_TONE, hair_tone=None, detected=False)
