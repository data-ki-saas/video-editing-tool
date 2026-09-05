from fastapi import APIRouter, Depends, File, Form, UploadFile

from src.core.auth import CurrentUser, get_current_user
from src.library import service
from src.library.schemas import LibraryVideo, LibraryVideosResponse, SetTemplateRequest, UpdateLibraryVideoRequest

router = APIRouter(prefix="/api/library", tags=["library"])


@router.get("", response_model=LibraryVideosResponse)
async def list_videos(user: CurrentUser = Depends(get_current_user)) -> LibraryVideosResponse:
    return service.list_videos(user)


@router.get("/public/{video_id}", response_model=LibraryVideo)
async def get_public_video(video_id: str) -> LibraryVideo:
    """No auth dependency on purpose -- see service.get_public_video's own
    comment. Backs the public /share/[videoId] page."""
    return service.get_public_video(video_id)


@router.post("", response_model=LibraryVideo, status_code=201)
async def save_video(
    video: UploadFile,
    project_id: str = Form(...),
    duration_seconds: float | None = Form(None),
    thumbnail: UploadFile | None = File(None),
    user: CurrentUser = Depends(get_current_user),
) -> LibraryVideo:
    return await service.save_video(
        project_id=project_id, video=video, thumbnail=thumbnail, duration_seconds=duration_seconds, user=user
    )


@router.patch("/{video_id}/template", response_model=LibraryVideo)
async def set_template(
    video_id: str, body: SetTemplateRequest, user: CurrentUser = Depends(get_current_user)
) -> LibraryVideo:
    return service.set_is_template(video_id, body.is_template, user)


@router.patch("/{video_id}", response_model=LibraryVideo)
async def update_video(
    video_id: str, body: UpdateLibraryVideoRequest, user: CurrentUser = Depends(get_current_user)
) -> LibraryVideo:
    return service.update_video(video_id, body.project_name, body.description, user)


@router.delete("/{video_id}", status_code=204)
async def delete_video(video_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.delete_video(video_id, user)
