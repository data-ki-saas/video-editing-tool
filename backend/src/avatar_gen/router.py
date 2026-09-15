from fastapi import APIRouter, Depends, File, Form, UploadFile

from src.avatar_gen import service
from src.avatar_gen.schemas import (
    GeneratedAvatarCreateResponse,
    GeneratedAvatarDetail,
    GeneratedAvatarDuplicateRequest,
    GeneratedAvatarRenameRequest,
    GeneratedAvatarSummary,
)
from src.core.auth import CurrentUser, get_current_user, require_feature

# Nested under /api/avatar (same URL family as avatar/router.py's own
# /api/avatar/direct) but its own router/module -- Phase 6's photo -> Skin
# generator is a distinct concern (CV + image synthesis + its own storage
# table) from Phase 4's LLM-glue direct_avatar_actions, even though both
# live under the same "Avatar" feature area.
router = APIRouter(prefix="/api/avatar/generated", tags=["avatar"])


@router.post("", response_model=GeneratedAvatarCreateResponse, status_code=201)
async def generate_from_photo(
    file: UploadFile = File(...),
    name: str | None = Form(default=None),
    user: CurrentUser = Depends(require_feature("avatar_generate")),
) -> GeneratedAvatarCreateResponse:
    body = await file.read()
    return await service.generate_avatar_from_photo(user=user, name=name, file_content_type=file.content_type, photo_bytes=body)


@router.get("", response_model=list[GeneratedAvatarSummary])
async def list_generated(user: CurrentUser = Depends(get_current_user)) -> list[GeneratedAvatarSummary]:
    return service.list_generated_avatars(user)


@router.get("/{design_id}", response_model=GeneratedAvatarDetail)
async def get_generated(design_id: str, user: CurrentUser = Depends(get_current_user)) -> GeneratedAvatarDetail:
    return service.get_generated_avatar(design_id, user)


@router.patch("/{design_id}", response_model=GeneratedAvatarDetail)
async def rename_generated(
    design_id: str, body: GeneratedAvatarRenameRequest, user: CurrentUser = Depends(get_current_user)
) -> GeneratedAvatarDetail:
    return service.rename_generated_avatar(design_id, user, body.name)


@router.post("/{design_id}/duplicate", response_model=GeneratedAvatarDetail, status_code=201)
async def duplicate_generated(
    design_id: str, body: GeneratedAvatarDuplicateRequest, user: CurrentUser = Depends(get_current_user)
) -> GeneratedAvatarDetail:
    return service.duplicate_generated_avatar(design_id, user, body.name, body.overrides)


@router.delete("/{design_id}", status_code=204)
async def delete_generated(design_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.delete_generated_avatar(design_id, user)
