import logging
from datetime import datetime, timedelta, timezone

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

_TABLE = "usage_events"


def count_recent_events(user_id: str, event_type: str) -> int | None:
    """Fail-OPEN on a read error (returns None), same convention as
    avatar/repository.py's count_recent_avatar_events -- a usage_events
    hiccup shouldn't block this summary from rendering the other rows.
    Generic across event_type here (unlike each feature's own private
    helper) since this is the one place that needs all three at once."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    try:
        result = (
            get_supabase_client()
            .table(_TABLE)
            .select("id", count="exact")
            .eq("user_id", user_id)
            .eq("event_type", event_type)
            .gte("created_at", since)
            .execute()
        )
    except Exception:
        logger.exception("failed to count usage events for user=%s event_type=%s", user_id, event_type)
        return None
    return result.count or 0
