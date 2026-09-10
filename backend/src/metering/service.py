import logging
from collections import defaultdict

from src.metering import repository
from src.metering.schemas import (
    AdminUsageSummaryResponse,
    CapWarning,
    CapWarningsResponse,
    DailyCost,
    ProviderRunwayResponse,
    ProviderTopUp,
    TopUser,
    UsageTotal,
)
from src.permissions import repository as permissions_repository

logger = logging.getLogger(__name__)

# Which usage_ledger `provider` values roll up into each admin-facing
# "account" runway card -- fal.ai bills both the VEED (video) and rembg
# (photo) matting jobs through the ONE account/API key (see admin/
# integrations page's own note), so both share the one "fal" top-up ledger
# even though usage_ledger itself keeps them as two distinct provider values.
_RUNWAY_PROVIDER_LEDGER_KEYS = {"fal": ["fal_rembg", "fal_veed"]}


def get_admin_summary(days: int = 30) -> AdminUsageSummaryResponse:
    events = repository.fetch_recent_events(days)

    totals_by_type: dict[str, dict[str, float]] = defaultdict(lambda: {"quantity": 0.0, "cost": 0.0, "count": 0})
    cost_by_day: dict[str, float] = defaultdict(float)
    cost_by_user: dict[str, float] = defaultdict(float)

    for event in events:
        if event.get("status") != "succeeded":
            continue
        event_type = event["event_type"]
        cost = float(event.get("cost_estimate_cents") or 0)

        bucket = totals_by_type[event_type]
        bucket["quantity"] += float(event.get("quantity") or 0)
        bucket["cost"] += cost
        bucket["count"] += 1

        day = str(event["created_at"])[:10]
        cost_by_day[day] += cost
        cost_by_user[event["user_id"]] += cost

    totals = [
        UsageTotal(event_type=event_type, quantity_sum=bucket["quantity"], cost_estimate_cents_sum=bucket["cost"], count=int(bucket["count"]))
        for event_type, bucket in sorted(totals_by_type.items())
    ]
    daily = [DailyCost(date=day, cost_estimate_cents=cost) for day, cost in sorted(cost_by_day.items())]

    top_user_ids = sorted(cost_by_user, key=lambda user_id: cost_by_user[user_id], reverse=True)[:10]
    top_users = []
    for user_id in top_user_ids:
        basic = permissions_repository.get_user_basic(user_id)
        top_users.append(
            TopUser(user_id=user_id, email=basic["email"] if basic else None, cost_estimate_cents_sum=cost_by_user[user_id])
        )

    return AdminUsageSummaryResponse(days=days, totals=totals, daily=daily, top_users=top_users)


def record_cap_hit(*, user_id: str, feature: str, cap_value: int, count_at_trigger: int) -> None:
    """Called by every daily-cap enforcement site (tts/service.py,
    avatar/service.py, matting/service.py, usage/service.py's
    assert_render_cap) right before it raises 429 -- a WARNING-level log
    line (visible in Render's log viewer with no extra setup) plus a
    cap_warnings row an admin can see on /admin/usage without digging
    through logs."""
    logger.warning("user=%s hit daily cap feature=%s count=%s/%s", user_id, feature, count_at_trigger, cap_value)
    repository.record_cap_warning(user_id=user_id, feature=feature, cap_value=cap_value, count_at_trigger=count_at_trigger)


def list_cap_warnings(days: int = 7) -> CapWarningsResponse:
    rows = repository.fetch_recent_cap_warnings(days)
    warnings = []
    for row in rows:
        basic = permissions_repository.get_user_basic(row["user_id"])
        warnings.append(
            CapWarning(
                user_id=row["user_id"],
                email=basic["email"] if basic else None,
                feature=row["feature"],
                cap_value=row["cap_value"],
                count_at_trigger=row["count_at_trigger"],
                created_at=row["created_at"],
            )
        )
    return CapWarningsResponse(days=days, warnings=warnings)


def record_provider_topup(*, provider: str, amount_cents: float, note: str | None, created_by: str) -> ProviderTopUp:
    row = repository.create_topup(provider=provider, amount_cents=amount_cents, note=note, created_by=created_by)
    return ProviderTopUp(id=row["id"], provider=row["provider"], amount_cents=row["amount_cents"], note=row.get("note"), created_at=row["created_at"])


def get_provider_runway(provider: str) -> ProviderRunwayResponse:
    """Manually-topped-up balance minus this app's own tracked spend for
    that provider -- see provider_topups' own migration comment for why
    this is hand-logged rather than pulled from the provider's own API
    (fal.ai exposes no balance endpoint we're aware of)."""
    ledger_providers = _RUNWAY_PROVIDER_LEDGER_KEYS.get(provider, [provider])
    spent_cents, job_count = repository.sum_succeeded_cost_cents(ledger_providers)
    topup_rows = repository.fetch_topups(provider)
    topped_up_cents = sum(float(row.get("amount_cents") or 0) for row in topup_rows)
    topups = [
        ProviderTopUp(id=row["id"], provider=row["provider"], amount_cents=row["amount_cents"], note=row.get("note"), created_at=row["created_at"])
        for row in topup_rows
    ]
    return ProviderRunwayResponse(
        provider=provider,
        topped_up_cents=topped_up_cents,
        spent_cents=spent_cents,
        remaining_cents=topped_up_cents - spent_cents,
        job_count=job_count,
        topups=topups,
    )
