from fastapi import APIRouter, Depends

from src.avatar import service
from src.avatar.schemas import DirectAvatarRequest, DirectAvatarResponse
from src.core.auth import CurrentUser, require_feature
from src.llm.client import get_llm_provider

router = APIRouter(prefix="/api/avatar", tags=["avatar"])


@router.post("/direct", response_model=DirectAvatarResponse)
async def direct_avatar(
    request: DirectAvatarRequest, user: CurrentUser = Depends(require_feature("avatar_direct"))
) -> DirectAvatarResponse:
    return await service.direct_avatar_actions(
        request.script, request.narration_duration_seconds, request.action_ids, user.id, get_llm_provider()
    )
