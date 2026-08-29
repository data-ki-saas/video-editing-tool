from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, get_current_user, require_feature
from src.tts import service
from src.tts.schemas import SynthesizeRequest, SynthesizeResponse, VoicesResponse

router = APIRouter(prefix="/api/tts", tags=["tts"])


@router.post("/synthesize", response_model=SynthesizeResponse, status_code=201)
async def synthesize(
    body: SynthesizeRequest, user: CurrentUser = Depends(require_feature("tts_synthesize"))
) -> SynthesizeResponse:
    return await service.synthesize(body.project_id, body.text, body.voice, body.rate, body.pitch, user)


@router.get("/voices", response_model=VoicesResponse)
async def list_voices(user: CurrentUser = Depends(get_current_user)) -> VoicesResponse:
    return service.list_voices()
