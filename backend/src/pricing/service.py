import re
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import HTTPException

from src.core.auth import CurrentUser
from src.pricing import catalog, repository
from src.pricing.schemas import (
    BillingLine,
    BillingStatement,
    CurrentPrice,
    PriceHistoryEntry,
    PricedResource,
    PricingResponse,
)

_HISTORY_LIMIT = 8
_MONTH_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


def list_pricing() -> PricingResponse:
    rows = repository.list_prices()
    by_key: dict[str, list[dict]] = defaultdict(list)
    for row in rows:  # already newest first
        by_key[row["resource_key"]].append(row)

    resources = []
    for item in catalog.RESOURCES:
        history = by_key.get(item.key, [])
        current = history[0] if history else None
        resources.append(
            PricedResource(
                key=item.key,
                label=item.label,
                unit_label=item.unit_label,
                per=item.per,
                unit_price_cents=float(current["unit_price_cents"]) if current else None,
                effective_from=str(current["effective_from"]) if current else None,
                provider_cost_cents=item.provider_cost_cents(),
                history=[
                    PriceHistoryEntry(unit_price_cents=float(r["unit_price_cents"]), effective_from=str(r["effective_from"]))
                    for r in history[:_HISTORY_LIMIT]
                ],
            )
        )
    return PricingResponse(resources=resources)


def set_price(resource_key: str, unit_price_cents: float, admin: CurrentUser) -> PricingResponse:
    """Applies from the instant the row commits: every usage event recorded
    after this snapshots the new price (metering/repository.py's
    record_event reads it uncached), and nothing already recorded changes."""
    if catalog.get_item(resource_key) is None:
        raise HTTPException(status_code=404, detail="Unknown consumption item")
    repository.insert_price(resource_key=resource_key, unit_price_cents=unit_price_cents, created_by=admin.id)
    return list_pricing()


def _month_bounds(month: str) -> tuple[datetime, datetime]:
    match = _MONTH_RE.match(month)
    if not match:
        raise HTTPException(status_code=400, detail="month must look like 2026-10")
    year, mon = int(match.group(1)), int(match.group(2))
    start = datetime(year, mon, 1, tzinfo=timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=timezone.utc) if mon == 12 else datetime(year, mon + 1, 1, tzinfo=timezone.utc)
    return start, end


def current_month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


def get_billing_statement(user: CurrentUser, month: str) -> BillingStatement:
    start, end = _month_bounds(month)
    rows = repository.fetch_user_ledger_rows(user.id, start.isoformat(), end.isoformat())

    groups: dict[tuple[str, float | None], dict[str, float]] = {}
    unpriced = 0
    for row in rows:
        key = row.get("resource_key")
        if key is None or catalog.get_item(key) is None:
            continue  # event type that is never priced (e.g. free local fallback)
        if row.get("charge_cents") is None:
            unpriced += 1
            continue
        unit_price = float(row["unit_price_cents"])
        bucket = groups.setdefault((key, unit_price), {"quantity": 0.0, "charge": 0.0})
        bucket["quantity"] += float(row["quantity"])
        bucket["charge"] += float(row["charge_cents"])

    lines = []
    for (key, unit_price), bucket in sorted(groups.items(), key=lambda kv: (catalog.RESOURCES.index(catalog.get_item(kv[0][0])), kv[0][1])):
        item = catalog.get_item(key)
        lines.append(
            BillingLine(
                key=key,
                label=item.label,
                unit_label=item.unit_label,
                unit_price_cents=unit_price,
                quantity=bucket["quantity"],
                units=bucket["quantity"] / item.per,
                charge_cents=bucket["charge"],
            )
        )

    prices = {r.key: r.unit_price_cents for r in list_pricing().resources}
    return BillingStatement(
        month=month,
        lines=lines,
        total_cents=sum(line.charge_cents for line in lines),
        unpriced_events=unpriced,
        current_prices=[
            CurrentPrice(key=i.key, label=i.label, unit_label=i.unit_label, unit_price_cents=prices.get(i.key))
            for i in catalog.RESOURCES
        ],
    )
