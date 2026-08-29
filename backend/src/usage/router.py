from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, get_current_user
from src.usage import service
from src.usage.schemas import UsageSummaryResponse

router = APIRouter(prefix="/api/usage", tags=["usage"])


@router.get("/summary", response_model=UsageSummaryResponse)
async def get_summary(user: CurrentUser = Depends(get_current_user)) -> UsageSummaryResponse:
    return service.get_summary(user)
