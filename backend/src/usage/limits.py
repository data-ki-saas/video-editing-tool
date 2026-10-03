import logging

from fastapi import HTTPException

from src.core.auth import CurrentUser, bypasses_daily_caps
from src.core.config import settings
from src.core.supabase_client import get_supabase_client
from src.metering import service as metering_service

logger = logging.getLogger(__name__)

WINDOW_SECONDS = 24 * 60 * 60


def _call_reserve(
    *, user_id: str, event_type: str, user_cap: int | None, global_cap: int | None, cost_cents: float
) -> dict:
    """Thin seam over the reserve_usage SQL function (migration 0043) so tests
    can stub the database round trip."""
    result = (
        get_supabase_client()
        .rpc(
            "reserve_usage",
            {
                "p_user_id": user_id,
                "p_event_type": event_type,
                "p_user_cap": user_cap,
                "p_global_cap": global_cap,
                "p_window_seconds": WINDOW_SECONDS,
                "p_cost_cents": cost_cents,
                "p_global_budget_cents": settings.paid_provider_daily_budget_cents,
            },
        )
        .execute()
    )
    return result.data


def reserve(
    *,
    user: CurrentUser,
    event_type: str,
    feature: str,
    noun: str,
    user_cap: int,
    global_cap: int | None = None,
    cost_cents: float = 0.0,
) -> None:
    """Atomically claims one unit of `event_type` for `user`, or raises.

    Call this BEFORE any external spend or storage write, never after: the
    reservation row is the count, so concurrent requests cannot all pass a
    stale check. Deliberately never refunded -- a provider call that timed out
    on our side may still have billed, so a failed attempt keeps its slot.

    Fails CLOSED: if the reservation cannot be made (database error, bad
    response) the feature is refused with 503 rather than allowed through
    unmetered. Admins skip the per-user and per-site COUNT caps (see
    core/auth.py's bypasses_daily_caps) but never the site-wide cost budget,
    so a stolen admin session still cannot run up an unbounded bill."""
    unlimited = bypasses_daily_caps(user)
    try:
        outcome = _call_reserve(
            user_id=user.id,
            event_type=event_type,
            user_cap=None if unlimited else user_cap,
            global_cap=None if unlimited else global_cap,
            cost_cents=cost_cents,
        )
        status = outcome["status"]
    except Exception as exc:
        logger.exception("usage reservation failed for user=%s event_type=%s", user.id, event_type)
        raise HTTPException(
            status_code=503, detail="Usage tracking is temporarily unavailable -- please try again in a minute."
        ) from exc

    if status == "ok":
        return

    if status == "user_cap":
        metering_service.record_cap_hit(
            user_id=user.id, feature=feature, cap_value=user_cap, count_at_trigger=int(outcome.get("user_count", user_cap)) + 1
        )
        raise HTTPException(
            status_code=429, detail=f"You've reached the limit of {user_cap} {noun} per day. Try again tomorrow."
        )

    if status == "global_cap":
        metering_service.record_cap_hit(
            user_id=user.id,
            feature=f"{feature}_site",
            cap_value=global_cap or 0,
            count_at_trigger=int(outcome.get("global_count", global_cap or 0)) + 1,
        )
    elif status == "global_budget":
        metering_service.record_cap_hit(
            user_id=user.id,
            feature=f"{feature}_budget",
            cap_value=int(settings.paid_provider_daily_budget_cents),
            count_at_trigger=int(float(outcome.get("global_cost_cents", 0)) + cost_cents),
        )
    else:
        logger.error("unexpected reserve_usage status %r for user=%s event_type=%s", status, user.id, event_type)
    raise HTTPException(
        status_code=503,
        detail="This feature is at capacity right now. Please try again later.",
    )
