from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, require_feature
from src.metering import service
from src.metering.schemas import AdminUsageSummaryResponse

router = APIRouter(prefix="/api/metering", tags=["metering"])


@router.get("/admin-summary", response_model=AdminUsageSummaryResponse)
async def get_admin_summary(
    days: int = 30, user: CurrentUser = Depends(require_feature("metering_admin_view"))
) -> AdminUsageSummaryResponse:
    return service.get_admin_summary(days)
