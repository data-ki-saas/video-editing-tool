"""Thin HTTP client for the standalone `face-analysis/` Cloud Run (GPU)
service -- the actual mediapipe FaceLandmarker analysis used to run
in-process here, but Render's native Python runtime has no apt/root access
to install the Mesa/GLES system libraries mediapipe's compiled bindings
need (`OSError: libGLESv2.so.2: cannot open shared object file`), which made
every photo analysis on Render silently fail and fall back to defaults --
see [[project_avatar_phase6_photo_gen]] for the incident this fixes.
face-analysis/src/photo_analysis.py is the real implementation (moved,
otherwise unchanged); this file preserves the exact same call signature and
fallback contract so avatar_gen/service.py needs no changes at all.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from src.core.config import settings

logger = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 20.0


@dataclass
class FacePalette:
    skin_tone: str
    hair_tone: str | None
    detected: bool
    face_width_scale: float = 1.0


_DEFAULT_SKIN_TONE = "#e8b48c"


def analyze_photo(photo_bytes: bytes) -> FacePalette:
    """Fails toward `FacePalette(detected=False)` on ANY error -- an
    unreachable service, a timeout (e.g. the GPU node cold-starting), or a
    non-200 response shouldn't fail the whole generation, same contract this
    function has always had. See face-analysis/src/photo_analysis.py's own
    docstring for the real detection logic."""
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
        )
    except Exception:
        logger.exception("face-analysis service call failed; falling back to default proportions")
        return FacePalette(skin_tone=_DEFAULT_SKIN_TONE, hair_tone=None, detected=False)
