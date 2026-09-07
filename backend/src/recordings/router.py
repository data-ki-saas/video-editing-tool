from fastapi import APIRouter, Depends, Form, UploadFile

from src.assets.schemas import AssetInfo
from src.core.auth import CurrentUser, get_current_user, require_feature
from src.recordings import service
from src.recordings.schemas import (
    AddRecordingToProjectRequest,
    RecordingInfo,
    RecordingsResponse,
    UpdateRecordingRequest,
)

router = APIRouter(
    prefix="/api/recordings", tags=["recordings"], dependencies=[Depends(require_feature("assets_manage"))]
)


@router.post("", response_model=RecordingInfo, status_code=201)
async def upload_recording(
    file: UploadFile,
    name: str = Form(...),
    description: str | None = Form(None),
    duration_seconds: float | None = Form(None),
    user: CurrentUser = Depends(get_current_user),
) -> RecordingInfo:
    return await service.upload_recording(
        file=file, name=name, description=description, duration_seconds=duration_seconds, user=user
    )


@router.get("", response_model=RecordingsResponse)
async def list_recordings(user: CurrentUser = Depends(get_current_user)) -> RecordingsResponse:
    return RecordingsResponse(recordings=service.list_recordings(user))


@router.patch("/{recording_id}", response_model=RecordingInfo)
async def update_recording(
    recording_id: str, body: UpdateRecordingRequest, user: CurrentUser = Depends(get_current_user)
) -> RecordingInfo:
    return service.update_recording(recording_id, body.name, body.description, user)


@router.put("/{recording_id}/content", response_model=RecordingInfo)
async def replace_recording_content(
    recording_id: str,
    file: UploadFile,
    duration_seconds: float | None = Form(None),
    user: CurrentUser = Depends(get_current_user),
) -> RecordingInfo:
    return await service.replace_content(recording_id, file, duration_seconds, user)


@router.delete("/{recording_id}", status_code=204)
async def delete_recording(recording_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.delete_recording(recording_id, user)


@router.post("/{recording_id}/add-to-project", response_model=AssetInfo, status_code=201)
async def add_recording_to_project(
    recording_id: str, body: AddRecordingToProjectRequest, user: CurrentUser = Depends(get_current_user)
) -> AssetInfo:
    return await service.add_to_project(recording_id, body.project_id, user)
