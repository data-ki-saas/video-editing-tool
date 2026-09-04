from pydantic import BaseModel


class UsageTotal(BaseModel):
    event_type: str
    quantity_sum: float
    cost_estimate_cents_sum: float
    count: int


class DailyCost(BaseModel):
    date: str
    cost_estimate_cents: float


class TopUser(BaseModel):
    user_id: str
    email: str | None
    cost_estimate_cents_sum: float


class AdminUsageSummaryResponse(BaseModel):
    days: int
    totals: list[UsageTotal]
    daily: list[DailyCost]
    top_users: list[TopUser]


class CapWarning(BaseModel):
    user_id: str
    email: str | None
    feature: str
    cap_value: int
    count_at_trigger: int
    created_at: str


class CapWarningsResponse(BaseModel):
    days: int
    warnings: list[CapWarning]
