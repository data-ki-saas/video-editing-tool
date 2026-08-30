import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

_TABLE = "usage_ledger"


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
