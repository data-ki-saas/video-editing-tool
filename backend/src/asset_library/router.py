from fastapi import APIRouter, Depends

from src.asset_library import service
from src.asset_library.schemas import LibraryAssetSummary, PromoteAvatarRequest
from src.assets.schemas import AssetInfo
from src.avatar_gen.schemas import GeneratedAvatarDetail
from src.core.auth import CurrentUser, get_current_user

router = APIRouter(prefix="/api/asset-library", tags=["asset-library"])


@router.get("", response_model=list[LibraryAssetSummary])
async def list_library(asset_type: str | None = None, user: CurrentUser = Depends(get_current_user)) -> list[LibraryAssetSummary]:
    return service.list_library(asset_type)


@router.post("/avatars/{design_id}/promote", response_model=LibraryAssetSummary, status_code=201)
async def promote_avatar(
    design_id: str, body: PromoteAvatarRequest, user: CurrentUser = Depends(get_current_user)
) -> LibraryAssetSummary:
    return service.promote_avatar(design_id, user, body.title, body.description, body.liability_waiver_accepted)


@router.post("/{library_asset_id}/import", response_model=GeneratedAvatarDetail, status_code=201)
async def import_library_asset(library_asset_id: str, user: CurrentUser = Depends(get_current_user)) -> GeneratedAvatarDetail:
    # Avatars only -- service.import_avatar 404s for any other asset_type.
    # Video/image/audio go through import_library_asset_to_project below
    # instead, since they land in a project's `assets`, not "My avatars".
    return service.import_avatar(library_asset_id, user)


@router.post("/{library_asset_id}/import-to-project", response_model=AssetInfo, status_code=201)
async def import_library_asset_to_project(
    library_asset_id: str, project_id: str, user: CurrentUser = Depends(get_current_user)
) -> AssetInfo:
    return service.import_media_to_project(library_asset_id, project_id, user)
