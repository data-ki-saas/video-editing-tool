from fastapi import APIRouter, Depends, UploadFile

from src.assets import service
from src.assets.schemas import AssetInfo
from src.core.auth import CurrentUser, get_current_user

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.post("", response_model=AssetInfo, status_code=201)
async def upload_asset(
    project_id: str, file: UploadFile, user: CurrentUser = Depends(get_current_user)
) -> AssetInfo:
    return await service.upload_asset(project_id, file, user)


@router.get("", response_model=list[AssetInfo])
async def list_assets(project_id: str, user: CurrentUser = Depends(get_current_user)) -> list[AssetInfo]:
    return service.list_assets(project_id, user)


@router.delete("/{asset_id}", status_code=204)
async def delete_asset(asset_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.delete_asset(asset_id, user)
