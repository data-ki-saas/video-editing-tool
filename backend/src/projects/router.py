from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, get_current_user
from src.projects import service

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.delete_project(project_id, user)


@router.post("/{project_id}/reset", status_code=204)
async def reset_project(project_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.reset_project(project_id, user)
