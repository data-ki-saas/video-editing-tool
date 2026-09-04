from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, require_feature
from src.metering import service
from src.metering.schemas import AdminUsageSummaryResponse, CapWarningsResponse

router = APIRouter(prefix="/api/metering", tags=["metering"])


@router.get("/admin-summary", response_model=AdminUsageSummaryResponse)
async def get_admin_summary(
    days: int = 30, user: CurrentUser = Depends(require_feature("metering_admin_view"))
) -> AdminUsageSummaryResponse:
    return service.get_admin_summary(days)


@router.get("/cap-warnings", response_model=CapWarningsResponse)
async def get_cap_warnings(
    days: int = 7, user: CurrentUser = Depends(require_feature("metering_admin_view"))
) -> CapWarningsResponse:
    return service.list_cap_warnings(days)
