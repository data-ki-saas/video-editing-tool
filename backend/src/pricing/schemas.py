from pydantic import BaseModel, Field


class PriceHistoryEntry(BaseModel):
    unit_price_cents: float
    effective_from: str


class PricedResource(BaseModel):
    key: str
    label: str
    unit_label: str
    per: float
    # None = no price set yet, i.e. free.
    unit_price_cents: float | None
    effective_from: str | None
    provider_cost_cents: float | None
    history: list[PriceHistoryEntry]


class PricingResponse(BaseModel):
    resources: list[PricedResource]


class SetPriceRequest(BaseModel):
    # Upper bound is a typo guard (a stray extra digit), not a business rule.
    unit_price_cents: float = Field(ge=0, le=1_000_000, allow_inf_nan=False)


class CurrentPrice(BaseModel):
    key: str
    label: str
    unit_label: str
    unit_price_cents: float | None


class BillingLine(BaseModel):
    key: str
    label: str
    unit_label: str
    # Price this line was charged at -- the snapshot taken when the usage
    # happened, so a mid-month price change yields separate lines.
    unit_price_cents: float | None
    quantity: float
    units: float
    charge_cents: float


class BillingStatement(BaseModel):
    month: str
    lines: list[BillingLine]
    total_cents: float
    # Usage in the month that was never priced (before pricing existed, or a
    # price lookup failed) -- shown so the statement never hides consumption.
    unpriced_events: int
    current_prices: list[CurrentPrice]
