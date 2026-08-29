from pydantic import BaseModel


class UsageSummaryItem(BaseModel):
    event_type: str
    label: str
    count: int
    limit: int


class UsageSummaryResponse(BaseModel):
    items: list[UsageSummaryItem]
