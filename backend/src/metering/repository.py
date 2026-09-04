import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

_TABLE = "usage_ledger"
_CAP_WARNINGS_TABLE = "cap_warnings"


def record_event(
    *,
    user_id: str,
    event_type: str,
    provider: str,
    quantity: float,
    unit: str,
    cost_estimate_cents: float,
    status: str = "succeeded",
    project_id: str | None = None,
    external_ref: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Best-effort, same convention as tts/repository.py's
    record_voiceover_event -- a failure here shouldn't fail a feature that
    already succeeded/was already kicked off."""
    try:
        get_supabase_client().table(_TABLE).insert(
            {
                "user_id": user_id,
                "project_id": project_id,
                "event_type": event_type,
                "provider": provider,
                "external_ref": external_ref,
                "quantity": quantity,
                "unit": unit,
                "cost_estimate_cents": cost_estimate_cents,
                "status": status,
                "metadata": metadata or {},
            }
        ).execute()
    except Exception:
        logger.exception("failed to record usage ledger event type=%s user=%s", event_type, user_id)


def fetch_recent_events(days: int) -> list[dict]:
    """Fail-open (empty list) on a read error, same convention as
    usage/repository.py's count_recent_events -- an admin dashboard hiccup
    shouldn't 500 the whole page. Capped at 5000 rows: fine for POC-scale
    volume; a materialized view/rollup is the natural next step once this
    stops being true."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        result = (
            get_supabase_client()
            .table(_TABLE)
            .select("user_id, project_id, event_type, provider, quantity, unit, cost_estimate_cents, status, created_at")
            .gte("created_at", since)
            .limit(5000)
            .execute()
        )
    except Exception:
        logger.exception("failed to fetch usage ledger events for last %s days", days)
        return []
    return result.data or []


def record_cap_warning(*, user_id: str, feature: str, cap_value: int, count_at_trigger: int) -> None:
    """Best-effort, same convention as usage_ledger's record_event above --
    a failure to log this warning shouldn't fail the 429 that already
    happened."""
    try:
        get_supabase_client().table(_CAP_WARNINGS_TABLE).insert(
            {
                "user_id": user_id,
                "feature": feature,
                "cap_value": cap_value,
                "count_at_trigger": count_at_trigger,
            }
        ).execute()
    except Exception:
        logger.exception("failed to record cap warning feature=%s user=%s", feature, user_id)


def fetch_recent_cap_warnings(days: int) -> list[dict]:
    """Fail-open (empty list) on a read error, same convention as
    fetch_recent_events above -- the admin dashboard's warning log
    shouldn't 500 the whole page."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        result = (
            get_supabase_client()
            .table(_CAP_WARNINGS_TABLE)
            .select("user_id, feature, cap_value, count_at_trigger, created_at")
            .gte("created_at", since)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
    except Exception:
        logger.exception("failed to fetch cap warnings for last %s days", days)
        return []
    return result.data or []
