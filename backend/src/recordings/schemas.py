from typing import Literal

from pydantic import BaseModel, Field

RecordingKind = Literal["video", "image"]
RecordingMimeType = Literal["video/mp4", "image/jpeg"]


class RecordingInfo(BaseModel):
    id: str
    user_id: str
    name: str
    description: str | None
    kind: RecordingKind
    mime_type: RecordingMimeType
    size_bytes: int
    # A presigned R2 URL, valid for settings.r2_signed_url_expires_seconds --
    # NOT a permanent link, same convention as assets/schemas.py's AssetInfo.url.
    url: str
    duration_seconds: float | None
    created_at: str
    updated_at: str


class RecordingsResponse(BaseModel):
    recordings: list[RecordingInfo]


class UpdateRecordingRequest(BaseModel):
    """Backs the recordings page's in-place name/description editing --
    both sent together, same convention as library's UpdateLibraryVideoRequest."""

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=120)


class AddRecordingToProjectRequest(BaseModel):
    project_id: str
