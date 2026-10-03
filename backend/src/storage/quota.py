import logging

from fastapi import HTTPException

from src.core.auth import CurrentUser, bypasses_daily_caps
from src.core.config import settings
from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


def _fetch_usage(user_id: str) -> tuple[int, int]:
    """(bytes, objects) this user holds in the private uploads bucket, summed
    in SQL by user_storage_usage (migration 0043)."""
    data = get_supabase_client().rpc("user_storage_usage", {"p_user_id": user_id}).execute().data
    return int(data["bytes"]), int(data["objects"])


def assert_can_store(user: CurrentUser, *, adding_bytes: int, adding_objects: int = 1) -> None:
    """Refuses a private-bucket write that would take `user` past their byte
    or object quota. Fails CLOSED on a read error. The check and the
    following insert run in one synchronous stretch inside a single process
    (see assets/service.py's store_asset_bytes), so concurrent uploads in
    that process cannot interleave between them.

    Admins bypass, same rule as the daily caps."""
    if bypasses_daily_caps(user):
        return
    try:
        used_bytes, used_objects = _fetch_usage(user.id)
    except Exception as exc:
        logger.exception("storage usage lookup failed for user=%s", user.id)
        raise HTTPException(
            status_code=503, detail="Storage tracking is temporarily unavailable -- please try again in a minute."
        ) from exc

    if used_objects + adding_objects > settings.max_objects_per_user:
        raise HTTPException(
            status_code=429,
            detail=f"You've reached the limit of {settings.max_objects_per_user} stored files -- delete some to add more.",
        )
    if used_bytes + adding_bytes > settings.storage_quota_mb * 1024 * 1024:
        raise HTTPException(
            status_code=429,
            detail=f"You've reached your {settings.storage_quota_mb} MB storage limit -- delete some files to add more.",
        )
