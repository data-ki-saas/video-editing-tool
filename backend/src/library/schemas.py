from pydantic import BaseModel, Field


class LibraryVideo(BaseModel):
    id: str
    project_id: str | None
    project_name: str
    description: str | None
    video_url: str
    thumbnail_url: str | None
    duration_seconds: float | None
    is_template: bool
    created_at: str


class LibraryVideosResponse(BaseModel):
    videos: list[LibraryVideo]


class SetTemplateRequest(BaseModel):
    is_template: bool


class UpdateLibraryVideoRequest(BaseModel):
    """Backs the library page's in-place name/description editing -- both
    sent together (the UI always has both fields open at once), not a
    partial-field PATCH."""

    project_name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=120)
