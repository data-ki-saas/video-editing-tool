import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

_TABLE = "avatar_generations"
_USAGE_TABLE = "usage_events"
_USAGE_EVENT_TYPE = "avatar_video"


@dataclass
class AvatarGenerationRecord:
    id: str
    project_id: str
    user_id: str
    avatar_id: str
    status: str
    asset_id: str | None
    error: str | None
    created_at: str


def create_generation(*, id: str, project_id: str, user_id: str, avatar_id: str) -> AvatarGenerationRecord:
    payload = {
        "id": id,
        "project_id": project_id,
        "user_id": user_id,
        "avatar_id": avatar_id,
        "status": "waiting",
    }
    result = get_supabase_client().table(_TABLE).insert(payload).execute()
    return AvatarGenerationRecord(**result.data[0])


def get_generation(id: str, user_id: str) -> AvatarGenerationRecord | None:
    result = get_supabase_client().table(_TABLE).select("*").eq("id", id).eq("user_id", user_id).limit(1).execute()
    if not result.data:
        return None
    return AvatarGenerationRecord(**result.data[0])


def get_generation_by_id(id: str) -> AvatarGenerationRecord | None:
    """Unscoped lookup, unlike get_generation above -- only ever called from
    the webhook handler, which authenticates the CALLER (the provider, via
    verify_webhook's shared secret) rather than any particular end user, so
    there's no user_id to scope by yet at that point. The provider's own
    video id is unguessable enough to be a safe lookup key here."""
    result = get_supabase_client().table(_TABLE).select("*").eq("id", id).limit(1).execute()
    if not result.data:
        return None
    return AvatarGenerationRecord(**result.data[0])


def mark_completed(id: str, asset_id: str) -> AvatarGenerationRecord | None:
    result = (
        get_supabase_client().table(_TABLE).update({"status": "completed", "asset_id": asset_id}).eq("id", id).execute()
    )
    if not result.data:
        return None
    return AvatarGenerationRecord(**result.data[0])


def mark_failed(id: str, error: str) -> AvatarGenerationRecord | None:
    result = get_supabase_client().table(_TABLE).update({"status": "failed", "error": error}).eq("id", id).execute()
    if not result.data:
        return None
    return AvatarGenerationRecord(**result.data[0])


def count_recent_avatar_events(user_id: str) -> int | None:
    """Same fail-OPEN-on-read-error reasoning as tts/repository.py's
    count_recent_voiceover_events -- a usage_events hiccup shouldn't block
    the feature entirely. Kept as its own small function (rather than a
    shared helper parameterized by event_type) since tts/repository.py
    doesn't expose one either -- each module owns its own usage-event
    helpers even though they share one table."""
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
        logger.exception("failed to check avatar-video rate limit for user=%s", user_id)
        return None
    return result.count or 0


def record_avatar_event(user_id: str) -> None:
    try:
        get_supabase_client().table(_USAGE_TABLE).insert({"user_id": user_id, "event_type": _USAGE_EVENT_TYPE}).execute()
    except Exception:
        logger.exception("failed to record avatar-video usage event for user=%s", user_id)
