import hmac
import logging

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel

from src.config import settings
from src.photo_analysis import FaceShape, HairLength, Point, analyze_photo

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="face-analysis")

_Box = tuple[float, float, float, float]


class FacePaletteResponse(BaseModel):
    skin_tone: str
    hair_tone: str | None
    detected: bool
    face_width_scale: float
    face_shape: FaceShape
    hair_length: HairLength
    face_oval: list[Point]
    left_eye: list[Point]
    right_eye: list[Point]
    left_eyebrow: list[Point]
    right_eyebrow: list[Point]
    mouth_width_scale: float
    nose_width_scale: float
    nose_center: Point
    head_crop_box: _Box | None
    mouth_crop_box: _Box | None
    eyebrow_crop_box: _Box | None
    eye_crop_box: _Box | None
    background_rgb: tuple[int, int, int] | None
    head_chin_fraction: float | None


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
        face_oval=palette.face_oval,
        left_eye=palette.left_eye,
        right_eye=palette.right_eye,
        left_eyebrow=palette.left_eyebrow,
        right_eyebrow=palette.right_eyebrow,
        mouth_width_scale=palette.mouth_width_scale,
        nose_width_scale=palette.nose_width_scale,
        nose_center=palette.nose_center,
        head_crop_box=palette.head_crop_box,
        mouth_crop_box=palette.mouth_crop_box,
        eyebrow_crop_box=palette.eyebrow_crop_box,
        eye_crop_box=palette.eye_crop_box,
        background_rgb=palette.background_rgb,
        head_chin_fraction=palette.head_chin_fraction,
    )
