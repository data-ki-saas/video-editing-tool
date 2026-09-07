import io
import logging
import re
import tempfile
import uuid
from pathlib import Path

import httpx
from fastapi import HTTPException, UploadFile
from mutagen.mp4 import MP4

from src.assets import repository as assets_repository
from src.assets.schemas import AssetInfo
from src.assets.service import store_asset_bytes
from src.core.auth import CurrentUser
from src.core.config import settings
from src.recordings import repository
from src.recordings.schemas import RecordingInfo
from src.storage import r2_client

logger = logging.getLogger(__name__)

_ALLOWED_TYPES = {"video/mp4": "video", "image/jpeg": "image"}
_UNSAFE_FILENAME_CHARS = re.compile(r"[^a-zA-Z0-9._-]")

# A free (or any role without the recordings_unlimited feature -- see
# permissions/features.py) account can keep at most this many recordings at
# once. A total-row-count cap, not a time-windowed daily one, so it's a
# plain count_for_user() check rather than usage/service.py's
# count_recent_events machinery (built entirely around a rolling 24h
# window -- a poor fit here).
FREE_RECORDINGS_LIMIT = 15

# Applies to every upload_recording call (both the Record button's own
# capture, which already client-side-caps itself at this same length via
# CameraCapturePage's MAX_RECORDING_SECONDS, and the Recordings page's
# Upload button, which accepts arbitrary pre-existing files with no such
# built-in bound) -- keeps this library's storage/size in check.
MAX_RECORDING_DURATION_SECONDS = 180


def _probe_video_duration_seconds(body: bytes) -> float | None:
    """Authoritative server-side duration for an uploaded mp4, via mutagen
    (pure-Python, no ffprobe/ffmpeg binary -- same technique already used by
    avatar/service.py to probe a HeyGen video). Returns None (fail OPEN, not
    closed) on a probe failure -- same convention as avatar/service.py's own
    probe -- rather than blocking an upload mutagen simply can't parse; the
    duration cap below only applies when a duration was actually measured."""
    try:
        return MP4(io.BytesIO(body)).info.length
    except Exception:
        logger.warning("could not probe uploaded recording's duration -- skipping the length check for this upload")
        return None


def _to_recording_info(record: repository.RecordingRecord) -> RecordingInfo:
    return RecordingInfo(
        id=record.id,
        user_id=record.user_id,
        name=record.name,
        description=record.description,
        kind=record.kind,
        mime_type=record.mime_type,
        size_bytes=record.size_bytes,
        url=r2_client.presigned_get_url(record.storage_key),
        duration_seconds=float(record.duration_seconds) if record.duration_seconds is not None else None,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _write_to_r2(*, user_id: str, filename: str, content_type: str, body: bytes) -> str:
    """Shared by upload_recording and replace_content -- validates size,
    writes `body` under a fresh storage_key, returns it. Raises on failure;
    callers decide what (if anything) needs cleaning up."""
    if not body:
        raise HTTPException(status_code=400, detail="File is empty")
    if len(body) > settings.max_upload_size_bytes:
        raise HTTPException(
            status_code=413, detail=f"File exceeds the {settings.max_upload_size_mb} MB upload limit"
        )

    safe_filename = _UNSAFE_FILENAME_CHARS.sub("_", filename)
    storage_key = f"recordings/{user_id}/{uuid.uuid4().hex}-{safe_filename}"

    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(body)
        tmp_path = Path(tmp.name)
    try:
        r2_client.upload_file(tmp_path, storage_key, content_type)
    except Exception as exc:
        logger.exception("recording store failed to write file to R2: user=%s filename=%r", user_id, filename)
        raise HTTPException(status_code=502, detail="Failed to store the file") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    return storage_key


async def upload_recording(
    *,
    file: UploadFile,
    name: str,
    description: str | None,
    duration_seconds: float | None,
    user: CurrentUser,
) -> RecordingInfo:
    kind = _ALLOWED_TYPES.get(file.content_type or "")
    if not kind or not file.filename:
        raise HTTPException(status_code=400, detail="Only .mp4 video or .jpg photo recordings are supported")

    if "recordings_unlimited" not in user.features and repository.count_for_user(user.id) >= FREE_RECORDINGS_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"Free accounts are limited to {FREE_RECORDINGS_LIMIT} recordings -- delete one to add another.",
        )

    body = await file.read()

    if kind == "video":
        probed_duration = _probe_video_duration_seconds(body)
        if probed_duration is not None:
            if probed_duration > MAX_RECORDING_DURATION_SECONDS:
                raise HTTPException(
                    status_code=400,
                    detail=f"Videos are limited to {MAX_RECORDING_DURATION_SECONDS // 60} minutes",
                )
            # Authoritative over whatever the client sent (or omitted) --
            # e.g. the Upload button's own arbitrary pre-existing files,
            # unlike CameraCapturePage's own recording timer.
            duration_seconds = probed_duration

    storage_key = _write_to_r2(user_id=user.id, filename=file.filename, content_type=file.content_type, body=body)

    try:
        record = repository.create(
            user_id=user.id,
            name=name,
            description=description,
            kind=kind,
            mime_type=file.content_type,
            size_bytes=len(body),
            storage_key=storage_key,
            duration_seconds=duration_seconds,
        )
    except Exception as exc:
        logger.exception("recording store failed to save metadata: user=%s filename=%r", user.id, file.filename)
        try:
            r2_client.delete_object(storage_key)
        except Exception:
            logger.exception("failed to clean up orphaned R2 object %r after a failed recording insert", storage_key)
        raise HTTPException(status_code=502, detail="Recording metadata insert failed") from exc

    return _to_recording_info(record)


def list_recordings(user: CurrentUser) -> list[RecordingInfo]:
    return [_to_recording_info(record) for record in repository.list_for_user(user.id)]


def update_recording(recording_id: str, name: str, description: str | None, user: CurrentUser) -> RecordingInfo:
    record = repository.update_metadata(recording_id, user.id, name, description)
    if record is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    return _to_recording_info(record)


async def replace_content(
    recording_id: str, file: UploadFile, duration_seconds: float | None, user: CurrentUser
) -> RecordingInfo:
    """Backs the trim/crop popup's Save -- overwrites this recording's
    underlying media in place (same id/name/description). The old R2 object
    is only deleted once the DB row has been successfully repointed at the
    new one, so a mid-request failure never leaves the row referencing a
    since-deleted object."""
    existing = repository.get_owned(recording_id, user.id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Recording not found")

    kind = _ALLOWED_TYPES.get(file.content_type or "")
    if not kind or not file.filename:
        raise HTTPException(status_code=400, detail="Only .mp4 video or .jpg photo recordings are supported")

    body = await file.read()
    new_storage_key = _write_to_r2(
        user_id=user.id, filename=file.filename, content_type=file.content_type, body=body
    )

    record = repository.replace_content(
        recording_id,
        user.id,
        mime_type=file.content_type,
        size_bytes=len(body),
        storage_key=new_storage_key,
        duration_seconds=duration_seconds,
    )
    if record is None:
        try:
            r2_client.delete_object(new_storage_key)
        except Exception:
            logger.exception("failed to clean up orphaned R2 object %r after a failed recording content replace", new_storage_key)
        raise HTTPException(status_code=404, detail="Recording not found")

    try:
        r2_client.delete_object(existing.storage_key)
    except Exception:
        logger.exception("failed to delete old R2 object %r for edited recording %s", existing.storage_key, recording_id)

    return _to_recording_info(record)


def delete_recording(recording_id: str, user: CurrentUser) -> None:
    record = repository.delete(recording_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Recording not found")

    try:
        r2_client.delete_object(record.storage_key)
    except Exception:
        logger.exception("failed to delete R2 object %r for deleted recording %s", record.storage_key, recording_id)


async def add_to_project(recording_id: str, project_id: str, user: CurrentUser) -> AssetInfo:
    """Copies this recording's bytes into `project_id`'s own asset list --
    a fresh assets row with its own storage_key, NOT a shared reference to
    the recording's object (see this module's own doc comment on why: it
    keeps the two tables' delete lifecycles independent). Mirrors
    stock_media/service.py's import_stock_asset, which does the same
    download-then-store_asset_bytes dance for an external URL."""
    recording = repository.get_owned(recording_id, user.id)
    if recording is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    if not assets_repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")

    download_url = r2_client.presigned_get_url(recording.storage_key)
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(download_url)
        response.raise_for_status()
    except Exception as exc:
        logger.exception("failed to fetch recording %s for add-to-project", recording_id)
        raise HTTPException(status_code=502, detail="Failed to read this recording") from exc

    extension = ".mp4" if recording.kind == "video" else ".jpg"
    return store_asset_bytes(
        project_id=project_id,
        user=user,
        filename=f"{recording.name}{extension}",
        content_type=recording.mime_type,
        kind=recording.kind,
        body=response.content,
    )
