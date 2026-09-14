import hashlib
import hmac
import logging

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel

from src.config import settings
from src.photo_analysis import analyze_photo

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="face-analysis")


class FacePaletteResponse(BaseModel):
    skin_tone: str
    hair_tone: str | None
    detected: bool
    face_width_scale: float


def _fingerprint(value: str) -> str:
    """8-hex-char SHA-256 prefix -- enough to tell whether two secrets are
    the same string without ever logging (or letting anyone recover) the
    secret itself. TEMPORARY diagnostic for a live secret-mismatch --
    backend/src/avatar_gen/photo_analysis.py needs the matching debug line
    to compare against; remove both once the 401 is resolved."""
    return hashlib.sha256(value.encode()).hexdigest()[:8]


def _require_internal_secret(x_internal_secret: str = Header(default="")) -> None:
    expected = settings.face_analysis_service_secret
    if not expected or not hmac.compare_digest(x_internal_secret, expected):
        logger.warning(
            "internal secret mismatch: received len=%d fp=%s | expected len=%d fp=%s",
            len(x_internal_secret),
            _fingerprint(x_internal_secret) if x_internal_secret else "(empty)",
            len(expected),
            _fingerprint(expected) if expected else "(empty)",
        )
        raise HTTPException(status_code=401, detail="Invalid or missing internal secret")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/analyze", response_model=FacePaletteResponse, dependencies=[Depends(_require_internal_secret)])
async def analyze(file: UploadFile = File(...)) -> FacePaletteResponse:
    photo_bytes = await file.read()
    palette = analyze_photo(photo_bytes)
    return FacePaletteResponse(
        skin_tone=palette.skin_tone,
        hair_tone=palette.hair_tone,
        detected=palette.detected,
        face_width_scale=palette.face_width_scale,
    )
