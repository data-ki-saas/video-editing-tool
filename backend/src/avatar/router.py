from fastapi import APIRouter, Depends

from src.avatar import service
from src.avatar.schemas import (
    DirectAvatarRequest,
    DirectAvatarResponse,
    EditAvatarRequest,
    EditAvatarResponse,
    ResolveAvatarTagRequest,
    ResolveAvatarTagResponse,
)
from src.core.auth import CurrentUser, require_feature
from src.llm.client import get_llm_provider

router = APIRouter(prefix="/api/avatar", tags=["avatar"])


@router.post("/direct", response_model=DirectAvatarResponse)
async def direct_avatar(
    request: DirectAvatarRequest, user: CurrentUser = Depends(require_feature("avatar_direct"))
) -> DirectAvatarResponse:
    return await service.direct_avatar_actions(
        request.script,
        request.narration_duration_seconds,
        request.action_ids,
        request.gesture_ids,
        request.gaze_ids,
        request.mood_ids,
        request.locked_beats,
        user.id,
        get_llm_provider(),
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
        request.action_ids,
        request.garment_ids,
        user.id,
        get_llm_provider(),
    )


@router.post("/resolve-tag", response_model=ResolveAvatarTagResponse)
async def resolve_avatar_tag(
    request: ResolveAvatarTagRequest, user: CurrentUser = Depends(require_feature("avatar_edit"))
) -> ResolveAvatarTagResponse:
    return await service.resolve_avatar_tag(
        request.free_text, request.gesture_ids, request.gaze_ids, request.mood_ids, user.id, get_llm_provider()
    )
