from collections import defaultdict

from src.metering import repository
from src.metering.schemas import AdminUsageSummaryResponse, DailyCost, TopUser, UsageTotal
from src.permissions import repository as permissions_repository


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
