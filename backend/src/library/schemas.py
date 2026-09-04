from pydantic import BaseModel


class LibraryVideo(BaseModel):
    id: str
    project_id: str | None
    project_name: str
    video_url: str
    thumbnail_url: str | None
    duration_seconds: float | None
    is_template: bool
    created_at: str


class LibraryVideosResponse(BaseModel):
    videos: list[LibraryVideo]


class SetTemplateRequest(BaseModel):
    is_template: bool
