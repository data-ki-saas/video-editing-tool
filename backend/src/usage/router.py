from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, get_current_user
from src.pricing import service as pricing_service
from src.pricing.schemas import BillingStatement
from src.usage import service
from src.usage.schemas import UsageSummaryResponse

router = APIRouter(prefix="/api/usage", tags=["usage"])


@router.get("/summary", response_model=UsageSummaryResponse)
async def get_summary(user: CurrentUser = Depends(get_current_user)) -> UsageSummaryResponse:
    return service.get_summary(user)



@router.get("/billing", response_model=BillingStatement)
async def get_billing(month: str | None = None, user: CurrentUser = Depends(get_current_user)) -> BillingStatement:
    """The caller's own monthly statement (UTC calendar month, YYYY-MM;
    defaults to the current one). Always scoped to the signed-in user."""
    return pricing_service.get_billing_statement(user, month or pricing_service.current_month())
