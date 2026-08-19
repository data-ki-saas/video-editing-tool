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
}
_ALLOWED_EXTENSIONS = re.compile(r"\.(mp4|jpe?g|png)$", re.IGNORECASE)
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
        public_url=record.public_url,
        created_at=record.created_at,
    )


async def upload_asset(project_id: str, file: UploadFile, user: CurrentUser) -> AssetInfo:
    if not repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")

    kind = _ALLOWED_TYPES.get(file.content_type or "")
    if not kind or not file.filename or not _ALLOWED_EXTENSIONS.search(file.filename):
        raise HTTPException(status_code=400, detail="Only .mp4, .jpg, and .png files are supported")

    body = await file.read()
    if not body:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(body) > settings.max_upload_size_bytes:
        raise HTTPException(
            status_code=413, detail=f"File exceeds the {settings.max_upload_size_mb} MB upload limit"
        )

    safe_filename = _UNSAFE_FILENAME_CHARS.sub("_", file.filename)
    storage_key = f"projects/{project_id}/{uuid.uuid4().hex}-{safe_filename}"

    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(body)
        tmp_path = Path(tmp.name)

    try:
        public_url = r2_client.upload_file(tmp_path, storage_key, file.content_type)
    finally:
        tmp_path.unlink(missing_ok=True)

    try:
        record = repository.create_asset(
            project_id=project_id,
            uploaded_by=user.id,
            filename=file.filename,
            kind=kind,
            mime_type=file.content_type,
            size_bytes=len(body),
            storage_key=storage_key,
            public_url=public_url,
        )
    except Exception as exc:
        logger.exception(
            "asset upload failed to save metadata: user=%s project=%s filename=%r",
            user.id,
            project_id,
            file.filename,
        )
        try:
            r2_client.delete_object(storage_key)
        except Exception:
            logger.exception("failed to clean up orphaned R2 object %r after a failed upload", storage_key)
        raise HTTPException(status_code=502, detail="Asset metadata insert failed") from exc

    return _to_asset_info(record)


def list_assets(project_id: str, user: CurrentUser) -> list[AssetInfo]:
    if not repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")
    return [_to_asset_info(record) for record in repository.list_assets_for_project(project_id, user.id)]


def delete_asset(asset_id: str, user: CurrentUser) -> None:
    record = repository.delete_asset(asset_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    try:
        r2_client.delete_object(record.storage_key)
    except Exception:
        logger.exception("failed to delete R2 object %r for deleted asset %s", record.storage_key, asset_id)
