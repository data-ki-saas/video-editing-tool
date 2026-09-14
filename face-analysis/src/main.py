import hmac
import logging

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel

from src.config import settings
from src.photo_analysis import FaceShape, HairLength, analyze_photo

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="face-analysis")


class FacePaletteResponse(BaseModel):
    skin_tone: str
    hair_tone: str | None
    detected: bool
    face_width_scale: float
    face_shape: FaceShape
    hair_length: HairLength


def _require_internal_secret(x_internal_secret: str = Header(default="")) -> None:
    expected = settings.face_analysis_service_secret
    if not expected or not hmac.compare_digest(x_internal_secret, expected):
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
        face_shape=palette.face_shape,
        hair_length=palette.hair_length,
    )
