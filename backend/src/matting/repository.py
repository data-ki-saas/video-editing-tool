from dataclasses import dataclass

from src.core.supabase_client import get_supabase_client

_TABLE = "background_removals"


@dataclass
class BackgroundRemovalRecord:
    id: str
    source_asset_id: str
    user_id: str
    status: str
    matte_asset_id: str | None
    error: str | None
    created_at: str


def get_by_source_asset(source_asset_id: str, user_id: str) -> BackgroundRemovalRecord | None:
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*")
        .eq("source_asset_id", source_asset_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return BackgroundRemovalRecord(**result.data[0])


def create(*, id: str, source_asset_id: str, user_id: str) -> BackgroundRemovalRecord:
    payload = {"id": id, "source_asset_id": source_asset_id, "user_id": user_id, "status": "waiting"}
    result = get_supabase_client().table(_TABLE).insert(payload).execute()
    return BackgroundRemovalRecord(**result.data[0])


def get_by_id(id: str) -> BackgroundRemovalRecord | None:
    """Unscoped lookup, only ever called from the webhook handler -- the
    provider is authenticated via verify_webhook's signature/secret, not a
    signed-in user, so there's no user_id to scope by yet here."""
    result = get_supabase_client().table(_TABLE).select("*").eq("id", id).limit(1).execute()
    if not result.data:
        return None
    return BackgroundRemovalRecord(**result.data[0])


def mark_completed(id: str, matte_asset_id: str) -> BackgroundRemovalRecord | None:
    result = (
        get_supabase_client()
        .table(_TABLE)
        .update({"status": "completed", "matte_asset_id": matte_asset_id})
        .eq("id", id)
        .execute()
    )
    if not result.data:
        return None
    return BackgroundRemovalRecord(**result.data[0])


def mark_failed(id: str, error: str) -> BackgroundRemovalRecord | None:
    result = get_supabase_client().table(_TABLE).update({"status": "failed", "error": error}).eq("id", id).execute()
    if not result.data:
        return None
    return BackgroundRemovalRecord(**result.data[0])
