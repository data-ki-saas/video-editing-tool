import logging
import tempfile
import uuid
from pathlib import Path

import httpx
from fastapi import HTTPException

from src.asset_library import repository
from src.asset_library.schemas import LibraryAssetSummary
from src.assets import repository as assets_repository
from src.assets.schemas import AssetInfo
from src.assets.service import store_asset_bytes
from src.avatar_gen import repository as avatar_gen_repository
from src.avatar_gen.schemas import GeneratedAvatarDetail
from src.avatar_gen.service import resolve_avatar_record
from src.core.auth import CurrentUser
from src.storage import r2_client

logger = logging.getLogger(__name__)

_ALLOWED_ASSET_TYPES = {"avatar", "video", "image", "audio"}
_EXTENSION_BY_MIME = {"video/mp4": ".mp4", "image/jpeg": ".jpg", "image/png": ".png", "audio/mpeg": ".mp3"}
# "1-4 lines" is enforced loosely: at most 4 newlines and a generous overall
# length cap, rather than measuring rendered/wrapped lines -- there's no
# layout context here to know how a line actually wraps.
_MAX_DESCRIPTION_LINES = 4
_MAX_DESCRIPTION_CHARS = 480
_MAX_TITLE_CHARS = 80


def _to_summary(record: repository.LibraryAssetRecord) -> LibraryAssetSummary:
    return LibraryAssetSummary(
        id=record.id,
        asset_type=record.asset_type,
        title=record.title,
        description=record.description,
        thumbnail_url=record.thumbnail_url,
        media_url=record.media_url,
        media_mime_type=record.media_mime_type,
        media_duration_seconds=record.media_duration_seconds,
        created_at=record.created_at,
    )


def _validate_promotion_fields(title: str, description: str | None, liability_waiver_accepted: bool) -> tuple[str, str | None]:
    trimmed_title = title.strip()
    if not trimmed_title:
        raise HTTPException(status_code=400, detail="Title is required")
    if len(trimmed_title) > _MAX_TITLE_CHARS:
        raise HTTPException(status_code=400, detail=f"Title must be {_MAX_TITLE_CHARS} characters or fewer")

    trimmed_description = (description or "").strip() or None
    if trimmed_description is not None:
        if len(trimmed_description) > _MAX_DESCRIPTION_CHARS:
            raise HTTPException(status_code=400, detail=f"Description must be {_MAX_DESCRIPTION_CHARS} characters or fewer")
        if trimmed_description.count("\n") >= _MAX_DESCRIPTION_LINES:
            raise HTTPException(status_code=400, detail=f"Description must be {_MAX_DESCRIPTION_LINES} lines or fewer")

    if not liability_waiver_accepted:
        raise HTTPException(status_code=400, detail="You must confirm the liability waiver to add this to the library")

    return trimmed_title, trimmed_description


def list_library(asset_type: str | None) -> list[LibraryAssetSummary]:
    if asset_type is not None and asset_type not in _ALLOWED_ASSET_TYPES:
        raise HTTPException(status_code=400, detail="Unknown asset type")
    return [_to_summary(record) for record in repository.list_public(asset_type)]


def promote_avatar(
    design_id: str, user: CurrentUser, title: str, description: str | None, liability_waiver_accepted: bool
) -> LibraryAssetSummary:
    trimmed_title, trimmed_description = _validate_promotion_fields(title, description, liability_waiver_accepted)

    record = avatar_gen_repository.get(design_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Avatar not found")

    # The library is public and permanent, so the atlas needs a copy in the
    # PUBLIC renders bucket with a real, never-expiring URL -- unlike
    # avatar_designs' own private atlas_key, which is only ever resolved to a
    # time-limited presigned URL (see resolve_avatar_record). boto3 can't
    # copy directly between the two buckets' separate credentials, so this
    # downloads the bytes and re-uploads them.
    try:
        atlas_bytes = r2_client.download_object(record.atlas_key)
    except Exception as exc:
        logger.exception("promote_avatar failed to read source atlas: design=%s", design_id)
        raise HTTPException(status_code=502, detail="Couldn't read this avatar's image -- try again") from exc

    promotion_id = f"lib-{uuid.uuid4().hex}"
    public_atlas_key = f"library-assets/avatars/{promotion_id}/atlas.png"
    with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tmp:
        tmp.write(atlas_bytes)
        tmp_path = Path(tmp.name)
    try:
        public_atlas_url = r2_client.upload_public_object(tmp_path, public_atlas_key, "image/png")
    except Exception as exc:
        logger.exception("promote_avatar failed to write public atlas: design=%s", design_id)
        raise HTTPException(status_code=502, detail="Couldn't save this avatar to the library -- try again") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    # Unlike avatar_designs' own blank-in-storage convention, this copy's
    # imageRef/thumbnail ARE baked in permanently -- the public bucket's URL
    # never expires, so there's nothing to re-resolve at read time.
    avatar_skin = {**record.skin, "atlas": {**record.skin["atlas"], "imageRef": public_atlas_url}}
    avatar_design = {**record.design, "meta": {**record.design["meta"], "thumbnail": public_atlas_url}}

    try:
        created = repository.create_avatar_promotion(
            id=promotion_id,
            promoted_by=user.id,
            title=trimmed_title,
            description=trimmed_description,
            thumbnail_url=public_atlas_url,
            avatar_skin=avatar_skin,
            avatar_design=avatar_design,
        )
    except Exception as exc:
        logger.exception("promote_avatar failed to save library row: design=%s", design_id)
        try:
            r2_client.delete_public_object(public_atlas_key)
        except Exception:
            logger.exception("failed to clean up orphaned public atlas %r", public_atlas_key)
        raise HTTPException(status_code=502, detail="Couldn't save this avatar to the library -- try again") from exc

    return _to_summary(created)


def import_avatar(library_asset_id: str, user: CurrentUser) -> GeneratedAvatarDetail:
    """Copies a promoted avatar into the CALLER's own "My avatars" -- a brand
    new avatar_designs row, same as duplicate_generated_avatar, so the
    importer gets a fully independent avatar (renamable/customizable/
    deletable) rather than a shared reference to someone else's design."""
    promotion = repository.get(library_asset_id)
    if promotion is None or promotion.asset_type != "avatar":
        raise HTTPException(status_code=404, detail="Library avatar not found")

    try:
        response = httpx.get(promotion.thumbnail_url, timeout=30)
        response.raise_for_status()
        atlas_bytes = response.content
    except Exception as exc:
        logger.exception("import_avatar failed to download public atlas: library_asset=%s", library_asset_id)
        raise HTTPException(status_code=502, detail="Couldn't import this avatar -- try again") from exc

    new_design_id = f"gen-{uuid.uuid4().hex}"
    new_atlas_key = f"avatars/{user.id}/{new_design_id}/atlas.png"
    with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tmp:
        tmp.write(atlas_bytes)
        tmp_path = Path(tmp.name)
    try:
        r2_client.upload_file(tmp_path, new_atlas_key, "image/png")
    except Exception as exc:
        logger.exception("import_avatar failed to write private atlas: library_asset=%s", library_asset_id)
        raise HTTPException(status_code=502, detail="Couldn't import this avatar -- try again") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    # Back to avatar_designs' own blank-in-storage convention -- this row's
    # atlas now lives in the PRIVATE bucket, so imageRef/thumbnail must be
    # cleared here the same way generate_avatar_from_photo leaves them, for
    # resolve_avatar_record to fill back in fresh at read time.
    new_skin = {**promotion.avatar_skin, "skinId": new_design_id, "atlas": {**promotion.avatar_skin["atlas"], "imageRef": ""}}
    new_design = {
        **promotion.avatar_design,
        "designId": new_design_id,
        "skinId": new_design_id,
        "meta": {**promotion.avatar_design["meta"], "name": promotion.title, "thumbnail": ""},
    }

    try:
        new_record = avatar_gen_repository.create(
            id=new_design_id, user_id=user.id, name=promotion.title, skin=new_skin, design=new_design, atlas_key=new_atlas_key
        )
    except Exception as exc:
        logger.exception("import_avatar failed to save avatar_designs row: library_asset=%s", library_asset_id)
        try:
            r2_client.delete_object(new_atlas_key)
        except Exception:
            logger.exception("failed to clean up orphaned imported atlas %r", new_atlas_key)
        raise HTTPException(status_code=502, detail="Couldn't import this avatar -- try again") from exc

    return resolve_avatar_record(new_record)


def import_media_to_project(library_asset_id: str, project_id: str, user: CurrentUser) -> AssetInfo:
    """Pulls a promoted video/image/audio library entry into `project_id`'s
    own `assets` -- the "browse, play/view/hear, then pull into your reel"
    flow LibraryAssetDialog's non-avatar tabs use. Re-downloads the bytes
    server-side from the library entry's own public media_url (same
    don't-trust-a-client-URL posture as stock_media/service.py's
    import_stock_asset) and hands them to the same store_asset_bytes every
    upload/stock-import already goes through, so the result behaves exactly
    like any other project asset afterward (dedup, presigned URL, etc.)."""
    if not assets_repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")

    promotion = repository.get(library_asset_id)
    if promotion is None or promotion.asset_type not in ("video", "image", "audio"):
        raise HTTPException(status_code=404, detail="Library asset not found")
    if not promotion.media_url or not promotion.media_mime_type:
        raise HTTPException(status_code=502, detail="This library item has no downloadable file")

    try:
        response = httpx.get(promotion.media_url, timeout=60)
        response.raise_for_status()
    except Exception as exc:
        logger.exception("import_media_to_project failed to download: library_asset=%s", library_asset_id)
        raise HTTPException(status_code=502, detail="Failed to download this library item") from exc

    extension = _EXTENSION_BY_MIME.get(promotion.media_mime_type, "")
    return store_asset_bytes(
        project_id=project_id,
        user=user,
        filename=f"{promotion.title}{extension}",
        content_type=promotion.media_mime_type,
        kind=promotion.asset_type,
        body=response.content,
    )
