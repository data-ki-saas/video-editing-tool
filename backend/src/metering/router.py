from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, require_feature
from src.metering import service
from src.metering.schemas import AdminUsageSummaryResponse, CapWarningsResponse, ProviderRunwayResponse, ProviderTopUp, ProviderTopUpCreate

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


@router.get("/providers/{provider}/runway", response_model=ProviderRunwayResponse)
async def get_provider_runway(
    provider: str, user: CurrentUser = Depends(require_feature("metering_admin_view"))
) -> ProviderRunwayResponse:
    return service.get_provider_runway(provider)


@router.post("/providers/{provider}/topups", response_model=ProviderTopUp, status_code=201)
async def create_provider_topup(
    provider: str, body: ProviderTopUpCreate, user: CurrentUser = Depends(require_feature("metering_admin_view"))
) -> ProviderTopUp:
    return service.record_provider_topup(provider=provider, amount_cents=body.amount_cents, note=body.note, created_by=user.id)
