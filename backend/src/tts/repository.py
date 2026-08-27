import logging
from datetime import datetime, timedelta, timezone

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

_TABLE = "usage_events"
_EVENT_TYPE = "voiceover"


def count_recent_voiceover_events(user_id: str) -> int | None:
    """Count of this user's voiceover usage_events in the last 24h, or None
    if the read itself failed -- callers must fail OPEN on None (same as the
    frontend's isUnderRenderRateLimit in api/render/route.ts), since a
    usage_events hiccup shouldn't block the TTS feature entirely."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    try:
        result = (
            get_supabase_client()
            .table(_TABLE)
            .select("id", count="exact")
            .eq("user_id", user_id)
            .eq("event_type", _EVENT_TYPE)
            .gte("created_at", since)
            .execute()
        )
    except Exception:
        logger.exception("failed to check voiceover rate limit for user=%s", user_id)
        return None
    return result.count or 0


def record_voiceover_event(user_id: str) -> None:
    """Best-effort usage record for the rate-limit check above -- a failure
    here shouldn't fail a synthesis that already succeeded."""
    try:
        get_supabase_client().table(_TABLE).insert({"user_id": user_id, "event_type": _EVENT_TYPE}).execute()
    except Exception:
        logger.exception("failed to record voiceover usage event for user=%s", user_id)
