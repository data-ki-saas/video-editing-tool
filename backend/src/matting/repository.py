import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

_TABLE = "background_removals"
_USAGE_TABLE = "usage_events"
_USAGE_EVENT_TYPE = "background_removal"


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
    """Unscoped lookup, only ever called from the webhook handler -- see
    avatar/repository.py's get_generation_by_id for the identical reasoning
    (the provider is authenticated via verify_webhook's signature/secret,
    not a signed-in user, so there's no user_id to scope by yet here)."""
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


def count_recent_matting_events(user_id: str) -> int | None:
    """Same fail-OPEN-on-read-error reasoning as avatar/repository.py's
    count_recent_avatar_events -- a usage_events hiccup shouldn't block the
    feature entirely."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    try:
        result = (
            get_supabase_client()
            .table(_USAGE_TABLE)
            .select("id", count="exact")
            .eq("user_id", user_id)
            .eq("event_type", _USAGE_EVENT_TYPE)
            .gte("created_at", since)
            .execute()
        )
    except Exception:
        logger.exception("failed to check background-removal rate limit for user=%s", user_id)
        return None
    return result.count or 0


def record_matting_event(user_id: str) -> None:
    try:
        get_supabase_client().table(_USAGE_TABLE).insert({"user_id": user_id, "event_type": _USAGE_EVENT_TYPE}).execute()
    except Exception:
        logger.exception("failed to record background-removal usage event for user=%s", user_id)
