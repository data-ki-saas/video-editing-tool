from fastapi import APIRouter, Depends, Query

from src.core.auth import CurrentUser, get_current_user, require_feature
from src.llm.client import get_llm_provider
from src.niches import service
from src.niches.schemas import GenerateNicheRequest, NicheConfig

router = APIRouter(prefix="/api/niches", tags=["niches"], dependencies=[Depends(require_feature("niches_use"))])


@router.get("", response_model=list[NicheConfig])
async def list_niches(
    language: str | None = Query(None), user: CurrentUser = Depends(get_current_user)
) -> list[NicheConfig]:
    return service.list_niches(language)


@router.post("", response_model=NicheConfig)
async def get_or_create_niche(
    request: GenerateNicheRequest, user: CurrentUser = Depends(get_current_user)
) -> NicheConfig:
    return await service.get_or_create_niche(request.name, user.id, get_llm_provider(), request.language)
