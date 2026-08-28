import logging
import tempfile
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from src.assets import repository as assets_repository
from src.assets import service as assets_service
from src.core.auth import CurrentUser
from src.core.config import settings
from src.projects import repository
from src.projects.schemas import ThumbnailInfo
from src.storage import r2_client

logger = logging.getLogger(__name__)

_ALLOWED_THUMBNAIL_TYPES = {"image/jpeg": "jpg", "image/png": "png"}


def _delete_assets_and_render(project_id: str, project: repository.ProjectRecord, user: CurrentUser) -> None:
    """Shared by delete_project and reset_project below: removes every
    asset's object (and, separately, any finished render) from R2. Assets go
    through assets_service.delete_asset() one by one instead of a bulk
    delete so its content-hash dedup reference counting (a shared upload
    can't be deleted out from under another project still using it) is
    respected exactly as it is for a manual single-asset delete."""
    for asset in assets_repository.list_assets_for_project(project_id, user.id):
        assets_service.delete_asset(asset.id, user)

    # render_url is only ever set once transferRenderToR2 (worker/src/
    # server.js) has actually finished writing the object -- absent means
    # either no render was ever started, or one is still in flight/failed
    # and never reached the renders bucket.
    if project.render_id and project.render_url:
        try:
            r2_client.delete_render_object(project_id, project.render_id)
        except Exception:
            logger.exception(
                "failed to delete R2 render object for project %s render %s", project_id, project.render_id
            )

    _delete_thumbnail_object(project_id, project.thumbnail_url)


def _delete_thumbnail_object(project_id: str, thumbnail_url: str | None) -> None:
    """Best-effort delete of the current cover image's R2 object, if any --
    shared by _delete_assets_and_render (project delete/reset) and
    upload_thumbnail/clear_thumbnail below (replacing or clearing a cover)."""
    if not thumbnail_url:
        return
    key = r2_client.thumbnail_key_from_url(thumbnail_url)
    if not key:
        return
    try:
        r2_client.delete_public_object(key)
    except Exception:
        logger.exception("failed to delete R2 thumbnail object for project %s (%r)", project_id, thumbnail_url)


def delete_project(project_id: str, user: CurrentUser) -> None:
    """Deletes a reel and every resource it owns, not just the DB row --
    the `assets` table FK is `on delete cascade`, but that alone would
    leave every asset's object (and, separately, any finished render)
    orphaned in R2 forever, since Postgres cascades don't reach outside
    the database."""
    project = repository.get_project(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    _delete_assets_and_render(project_id, project, user)
    repository.delete_project(project_id)


def reset_project(project_id: str, user: CurrentUser) -> None:
    """Wipes a reel's assets and render state but keeps the row -- the
    "Reset" action beside "Delete" in ProjectList, for clearing a reel back
    to empty without losing the reel itself. Same R2 cleanup as
    delete_project above; the other half of the reset (blanking `timeline`,
    which this never touches -- see repository.clear_render_state's own
    comment) happens back in the frontend via the normal saveTimeline path
    once this call succeeds."""
    project = repository.get_project(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    _delete_assets_and_render(project_id, project, user)
    repository.clear_render_state(project_id)
    repository.clear_thumbnail(project_id)


async def upload_thumbnail(
    project_id: str, file: UploadFile, source: str, time_seconds: float | None, user: CurrentUser
) -> ThumbnailInfo:
    """Backs the cover/thumbnail picker's two modes -- "frame" (the image is
    a JPEG captured client-side from CanvasPlayer's own canvas, `time_seconds`
    is the playhead position it was captured at) and "upload" (a user's own
    image, `time_seconds` is None). Goes through the backend rather than a
    direct Supabase write (like `timeline`) because it needs R2 credentials
    the frontend doesn't have. Always writes a FRESH key rather than
    overwriting the previous one, so a CDN-cached URL from a replaced cover
    is never served stale -- the previous object is deleted separately,
    below, once the new one is safely written."""
    project = repository.get_project(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    if source not in ("frame", "upload"):
        raise HTTPException(status_code=400, detail="source must be 'frame' or 'upload'")

    extension = _ALLOWED_THUMBNAIL_TYPES.get(file.content_type or "")
    if not extension:
        raise HTTPException(status_code=400, detail="Only .jpg and .png images are supported")

    body = await file.read()
    if not body:
        raise HTTPException(status_code=400, detail="File is empty")
    if len(body) > settings.max_upload_size_bytes:
        raise HTTPException(
            status_code=413, detail=f"File exceeds the {settings.max_upload_size_mb} MB upload limit"
        )

    effective_time_seconds = time_seconds if source == "frame" else None
    key = f"thumbnails/{project_id}/{uuid.uuid4().hex}.{extension}"

    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(body)
        tmp_path = Path(tmp.name)

    try:
        url = r2_client.upload_public_object(tmp_path, key, file.content_type)
    except Exception as exc:
        logger.exception("thumbnail upload failed to write to R2: project=%s source=%s", project_id, source)
        raise HTTPException(status_code=502, detail="Failed to store the image") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    repository.set_thumbnail(project_id, url=url, source=source, time_seconds=effective_time_seconds)
    _delete_thumbnail_object(project_id, project.thumbnail_url)

    return ThumbnailInfo(thumbnail_url=url, thumbnail_source=source, thumbnail_time_seconds=effective_time_seconds)


def clear_thumbnail(project_id: str, user: CurrentUser) -> None:
    project = repository.get_project(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    _delete_thumbnail_object(project_id, project.thumbnail_url)
    repository.clear_thumbnail(project_id)
