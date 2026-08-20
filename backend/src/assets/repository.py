import uuid
from dataclasses import dataclass

from src.core.supabase_client import get_supabase_client

_TABLE = "assets"


@dataclass
class AssetRecord:
    id: str
    project_id: str
    uploaded_by: str
    filename: str
    kind: str
    mime_type: str
    size_bytes: int
    storage_key: str
    created_at: str
    content_hash: str | None = None


def project_owned_by(project_id: str, owner_id: str) -> bool:
    result = (
        get_supabase_client()
        .table("projects")
        .select("id")
        .eq("id", project_id)
        .eq("owner_id", owner_id)
        .limit(1)
        .execute()
    )
    return bool(result.data)


def create_asset(
    *,
    project_id: str,
    uploaded_by: str,
    filename: str,
    kind: str,
    mime_type: str,
    size_bytes: int,
    storage_key: str,
    content_hash: str,
) -> AssetRecord:
    payload = {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        "uploaded_by": uploaded_by,
        "filename": filename,
        "kind": kind,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "storage_key": storage_key,
        "content_hash": content_hash,
    }
    result = get_supabase_client().table(_TABLE).insert(payload).execute()
    return AssetRecord(**result.data[0])


def find_by_content_hash(uploaded_by: str, content_hash: str) -> AssetRecord | None:
    """An existing asset of this uploader's with identical bytes, regardless
    of which project it belongs to -- lets upload_asset() reuse its
    storage_key instead of writing the same bytes to R2 again. Scoped to
    uploaded_by rather than checked globally so this can't be used to probe
    whether some other user has uploaded a given file."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*")
        .eq("uploaded_by", uploaded_by)
        .eq("content_hash", content_hash)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return AssetRecord(**result.data[0])


def count_assets_with_storage_key(storage_key: str) -> int:
    result = get_supabase_client().table(_TABLE).select("id", count="exact").eq("storage_key", storage_key).execute()
    return result.count or 0


def list_assets_for_project(project_id: str, owner_id: str) -> list[AssetRecord]:
    """Assets are scoped through their project's owner, not a direct
    owner_id column on the assets table itself (see the `assets` RLS
    policies in supabase/migrations) -- the service role bypasses RLS, so
    this join is re-checked explicitly here."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*, projects!inner(owner_id)")
        .eq("project_id", project_id)
        .eq("projects.owner_id", owner_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [AssetRecord(**{k: v for k, v in row.items() if k != "projects"}) for row in result.data]


def get_asset(asset_id: str, owner_id: str) -> AssetRecord | None:
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*, projects!inner(owner_id)")
        .eq("id", asset_id)
        .eq("projects.owner_id", owner_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    row = result.data[0]
    return AssetRecord(**{k: v for k, v in row.items() if k != "projects"})


def delete_asset(asset_id: str, owner_id: str) -> AssetRecord | None:
    record = get_asset(asset_id, owner_id)
    if record is None:
        return None
    get_supabase_client().table(_TABLE).delete().eq("id", asset_id).execute()
    return record
