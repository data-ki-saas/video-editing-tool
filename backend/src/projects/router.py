from fastapi import APIRouter, Depends, Form, UploadFile

from src.core.auth import CurrentUser, get_current_user, require_feature
from src.projects import service
from src.projects.schemas import ThumbnailInfo

router = APIRouter(prefix="/api/projects", tags=["projects"], dependencies=[Depends(require_feature("projects_manage"))])


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.delete_project(project_id, user)


@router.post("/{project_id}/reset", status_code=204)
async def reset_project(project_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.reset_project(project_id, user)


@router.post("/{project_id}/thumbnail", response_model=ThumbnailInfo)
async def upload_thumbnail(
    project_id: str,
    file: UploadFile,
    source: str = Form(...),
    time_seconds: float | None = Form(None),
    user: CurrentUser = Depends(get_current_user),
) -> ThumbnailInfo:
    return await service.upload_thumbnail(project_id, file, source, time_seconds, user)


@router.delete("/{project_id}/thumbnail", status_code=204)
async def clear_thumbnail(project_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.clear_thumbnail(project_id, user)
