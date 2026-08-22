import hashlib
import logging
import re
import tempfile
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from src.assets import repository
from src.assets.schemas import AssetInfo
from src.core.auth import CurrentUser
from src.core.config import settings
from src.storage import r2_client

logger = logging.getLogger(__name__)

_ALLOWED_TYPES = {
    "video/mp4": "video",
    "image/jpeg": "image",
    "image/png": "image",
    "audio/mpeg": "audio",
}
_ALLOWED_EXTENSIONS = re.compile(r"\.(mp4|jpe?g|png|mp3)$", re.IGNORECASE)
_UNSAFE_FILENAME_CHARS = re.compile(r"[^a-zA-Z0-9._-]")


def _to_asset_info(record: repository.AssetRecord) -> AssetInfo:
    return AssetInfo(
        id=record.id,
        project_id=record.project_id,
        uploaded_by=record.uploaded_by,
        filename=record.filename,
        kind=record.kind,
        mime_type=record.mime_type,
        size_bytes=record.size_bytes,
        url=r2_client.presigned_get_url(record.storage_key),
        created_at=record.created_at,
    )


def store_asset_bytes(
    *, project_id: str, user: CurrentUser, filename: str, content_type: str, kind: str, body: bytes
) -> AssetInfo:
    """Dedup-by-content-hash + R2 write + DB insert, shared by every path
    that turns some bytes into a project asset -- a direct upload
    (upload_asset below) and importing a stock-media search result
    (stock_media/service.py) both call this rather than each reimplementing
    the same dedup/cleanup logic. Callers are responsible for their own
    content-type/extension validation and for confirming the caller owns
    `project_id` first -- this function only handles the storage side."""
    if not body:
        raise HTTPException(status_code=400, detail="File is empty")
    if len(body) > settings.max_upload_size_bytes:
        raise HTTPException(
            status_code=413, detail=f"File exceeds the {settings.max_upload_size_mb} MB upload limit"
        )

    content_hash = hashlib.md5(body).hexdigest()

    # If this user already has an asset with these exact bytes (in this
    # project or any other of theirs), reuse that object instead of writing
    # it to R2 again -- a new asset row still gets created below so this
    # project's asset list/timeline can reference it, but the storage_key
    # (and the R2 object it points at) is shared. delete_asset() below
    # reference-counts by storage_key before ever deleting the underlying
    # object.
    existing = repository.find_by_content_hash(user.id, content_hash)

    if existing is not None:
        storage_key = existing.storage_key
    else:
        safe_filename = _UNSAFE_FILENAME_CHARS.sub("_", filename)
        storage_key = f"projects/{project_id}/{uuid.uuid4().hex}-{safe_filename}"

        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp.write(body)
            tmp_path = Path(tmp.name)

        try:
            r2_client.upload_file(tmp_path, storage_key, content_type)
        except Exception as exc:
            logger.exception(
                "asset store failed to write file to R2: user=%s project=%s filename=%r",
                user.id,
                project_id,
                filename,
            )
            raise HTTPException(status_code=502, detail="Failed to store the file") from exc
        finally:
            tmp_path.unlink(missing_ok=True)

    try:
        record = repository.create_asset(
            project_id=project_id,
            uploaded_by=user.id,
            filename=filename,
            kind=kind,
            mime_type=content_type,
            size_bytes=len(body),
            storage_key=storage_key,
            content_hash=content_hash,
        )
    except Exception as exc:
        logger.exception(
            "asset store failed to save metadata: user=%s project=%s filename=%r",
            user.id,
            project_id,
            filename,
        )
        if existing is None:
            # Only clean up the R2 object if this call is the one that just
            # created it -- never delete a storage_key a deduped-in object
            # (existing is not None) or another asset row still points at.
            try:
                r2_client.delete_object(storage_key)
            except Exception:
                logger.exception("failed to clean up orphaned R2 object %r after a failed store", storage_key)
        raise HTTPException(status_code=502, detail="Asset metadata insert failed") from exc

    return _to_asset_info(record)


async def upload_asset(project_id: str, file: UploadFile, user: CurrentUser) -> AssetInfo:
    if not repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")

    kind = _ALLOWED_TYPES.get(file.content_type or "")
    if not kind or not file.filename or not _ALLOWED_EXTENSIONS.search(file.filename):
        raise HTTPException(status_code=400, detail="Only .mp4, .jpg, .png, and .mp3 files are supported")

    body = await file.read()
    return store_asset_bytes(
        project_id=project_id, user=user, filename=file.filename, content_type=file.content_type, kind=kind, body=body
    )


def list_assets(project_id: str, user: CurrentUser) -> list[AssetInfo]:
    if not repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")
    return [_to_asset_info(record) for record in repository.list_assets_for_project(project_id, user.id)]


def delete_asset(asset_id: str, user: CurrentUser) -> None:
    record = repository.delete_asset(asset_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Asset not found")

    # A deduped upload (see upload_asset above) can leave more than one asset
    # row pointing at the same storage_key -- only delete the R2 object once
    # this was the last row referencing it.
    if repository.count_assets_with_storage_key(record.storage_key) > 0:
        return

    try:
        r2_client.delete_object(record.storage_key)
    except Exception:
        logger.exception("failed to delete R2 object %r for deleted asset %s", record.storage_key, asset_id)
