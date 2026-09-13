from fastapi import APIRouter, Depends

from src.avatar import service
from src.avatar.schemas import DirectAvatarRequest, DirectAvatarResponse, EditAvatarRequest, EditAvatarResponse
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


@router.post("/edit", response_model=EditAvatarResponse)
async def edit_avatar(
    request: EditAvatarRequest, user: CurrentUser = Depends(require_feature("avatar_edit"))
) -> EditAvatarResponse:
    return await service.edit_avatar_design(
        request.prompt,
        request.bone_group_ids,
        request.color_slot_ids,
        request.accessories,
        request.expression_params,
        user.id,
        get_llm_provider(),
    )
