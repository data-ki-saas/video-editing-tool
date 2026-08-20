from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, get_current_user
from src.llm.client import get_llm_provider
from src.niches import service
from src.niches.schemas import GenerateNicheRequest, NicheConfig

router = APIRouter(prefix="/api/niches", tags=["niches"])


@router.get("", response_model=list[NicheConfig])
async def list_niches(user: CurrentUser = Depends(get_current_user)) -> list[NicheConfig]:
    return service.list_niches()


@router.post("", response_model=NicheConfig)
async def get_or_create_niche(
    request: GenerateNicheRequest, user: CurrentUser = Depends(get_current_user)
) -> NicheConfig:
    return await service.get_or_create_niche(request.name, user.id, get_llm_provider())
