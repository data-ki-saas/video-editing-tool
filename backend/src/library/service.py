import logging
import tempfile
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from src.core.auth import CurrentUser
from src.core.config import settings
from src.library import repository
from src.library.schemas import LibraryVideo, LibraryVideosResponse
from src.projects import repository as projects_repository
from src.storage import r2_client

logger = logging.getLogger(__name__)

_ALLOWED_VIDEO_TYPES = {"video/mp4": "mp4", "video/webm": "webm"}
_ALLOWED_THUMBNAIL_TYPES = {"image/jpeg": "jpg", "image/png": "png"}


def _record_to_schema(record: repository.LibraryVideoRecord) -> LibraryVideo:
    return LibraryVideo(
        id=record.id,
        project_id=record.project_id,
        project_name=record.project_name,
        video_url=record.video_url,
        thumbnail_url=record.thumbnail_url,
        duration_seconds=float(record.duration_seconds) if record.duration_seconds is not None else None,
        is_template=record.is_template,
        created_at=record.created_at,
    )


async def save_video(
    *,
    project_id: str,
    video: UploadFile,
    thumbnail: UploadFile | None,
    duration_seconds: float | None,
    user: CurrentUser,
) -> LibraryVideo:
    """Saves a finished Edge Render (client-side Mediabunny/WebCodecs
    export, see lib/localRender/exportTimeline.ts) into the user's
    permanent library -- the local render's own blob: URL only lives as
    long as that tab stays open, so this is the only way to keep one past
    that. Goes through the backend (like projects/service.py's
    upload_thumbnail) since only it holds R2 write credentials."""
    project = projects_repository.get_project(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    video_extension = _ALLOWED_VIDEO_TYPES.get(video.content_type or "")
    if not video_extension:
        raise HTTPException(status_code=400, detail="Only .mp4 and .webm videos are supported")

    video_body = await video.read()
    if not video_body:
        raise HTTPException(status_code=400, detail="Video file is empty")
    if len(video_body) > settings.max_upload_size_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds the {settings.max_upload_size_mb} MB upload limit")

    video_key = f"library/{user.id}/{uuid.uuid4().hex}.{video_extension}"
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(video_body)
        video_tmp_path = Path(tmp.name)
    try:
        video_url = r2_client.upload_public_object(video_tmp_path, video_key, video.content_type)
    except Exception as exc:
        logger.exception("library video upload failed to write to R2: project=%s", project_id)
        raise HTTPException(status_code=502, detail="Failed to save the video") from exc
    finally:
        video_tmp_path.unlink(missing_ok=True)

    # Best-effort -- a thumbnail capture failing client-side (or an
    # unrecognized type) shouldn't block saving the video itself; the
    # library page just falls back to "no preview" for this entry.
    thumbnail_url: str | None = None
    if thumbnail is not None:
        thumbnail_extension = _ALLOWED_THUMBNAIL_TYPES.get(thumbnail.content_type or "")
        thumbnail_body = await thumbnail.read()
        if thumbnail_extension and thumbnail_body:
            thumbnail_key = f"library/{user.id}/{uuid.uuid4().hex}.{thumbnail_extension}"
            with tempfile.NamedTemporaryFile(delete=False) as tmp:
                tmp.write(thumbnail_body)
                thumbnail_tmp_path = Path(tmp.name)
            try:
                thumbnail_url = r2_client.upload_public_object(thumbnail_tmp_path, thumbnail_key, thumbnail.content_type)
            except Exception:
                logger.exception("library thumbnail upload failed to write to R2: project=%s", project_id)
            finally:
                thumbnail_tmp_path.unlink(missing_ok=True)

    record = repository.create(
        user_id=user.id,
        project_id=project_id,
        project_name=project.name,
        video_url=video_url,
        thumbnail_url=thumbnail_url,
        duration_seconds=duration_seconds,
    )
    return _record_to_schema(record)


def list_videos(user: CurrentUser) -> LibraryVideosResponse:
    records = repository.list_for_user(user.id)
    return LibraryVideosResponse(videos=[_record_to_schema(r) for r in records])


def get_public_video(video_id: str) -> LibraryVideo:
    """Backs the public /share/[videoId] page -- deliberately no ownership
    check (no CurrentUser at all): the whole point of a share link is that
    someone without an account, or signed into a different one, can open
    it. Not a new privacy exposure -- video_url/thumbnail_url already point
    at an unauthenticated-readable public R2 bucket (see
    r2_client.upload_public_object); this just adds the project_name/
    duration alongside them."""
    record = repository.get_by_id(video_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return _record_to_schema(record)


def set_is_template(video_id: str, is_template: bool, user: CurrentUser) -> LibraryVideo:
    """Backs the library page's "Save as template" action button on an
    already-saved video -- a personal shortlist within the library (see
    0023's own comment), not a separate resource, so this just flips the
    one column rather than copying the row anywhere."""
    record = repository.set_is_template(video_id, user.id, is_template)
    if record is None:
        raise HTTPException(status_code=404, detail="Library video not found")
    return _record_to_schema(record)
