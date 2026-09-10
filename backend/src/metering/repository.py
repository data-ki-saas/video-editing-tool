import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

_TABLE = "usage_ledger"
_CAP_WARNINGS_TABLE = "cap_warnings"
_TOPUPS_TABLE = "provider_topups"


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


def sum_succeeded_cost_cents(providers: list[str]) -> tuple[float, int]:
    """All-time spend + job count for a set of usage_ledger `provider`
    values (e.g. ["fal_rembg", "fal_veed"] for the one fal.ai account both
    bill through) -- used by get_provider_runway, not fetch_recent_events's
    own days-windowed totals, since runway needs the account's real
    lifetime spend, not just a recent slice. Same fail-open-to-zero
    convention as fetch_recent_events; same 5000-row cap for POC-scale
    volume."""
    try:
        result = (
            get_supabase_client()
            .table(_TABLE)
            .select("cost_estimate_cents")
            .in_("provider", providers)
            .eq("status", "succeeded")
            .limit(5000)
            .execute()
        )
    except Exception:
        logger.exception("failed to sum usage ledger cost for providers=%s", providers)
        return 0.0, 0
    rows = result.data or []
    return sum(float(row.get("cost_estimate_cents") or 0) for row in rows), len(rows)


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


def create_topup(*, provider: str, amount_cents: float, note: str | None, created_by: str | None) -> dict:
    """Not best-effort like record_event/record_cap_warning above -- this
    IS the admin's actual action (not a side-log next to one that already
    succeeded), so a write failure should raise and surface to them rather
    than silently pretend the top-up was saved."""
    result = (
        get_supabase_client()
        .table(_TOPUPS_TABLE)
        .insert({"provider": provider, "amount_cents": amount_cents, "note": note, "created_by": created_by})
        .execute()
    )
    return result.data[0]


def fetch_topups(provider: str) -> list[dict]:
    """Fail-open (empty list) on a read error, same convention as
    fetch_recent_events above -- the integrations page's runway card
    shouldn't 500 over a read hiccup."""
    try:
        result = (
            get_supabase_client()
            .table(_TOPUPS_TABLE)
            .select("id, provider, amount_cents, note, created_at")
            .eq("provider", provider)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
    except Exception:
        logger.exception("failed to fetch provider topups for provider=%s", provider)
        return []
    return result.data or []
