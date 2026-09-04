from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, get_current_user
from src.usage import service
from src.usage.schemas import UsageSummaryResponse

router = APIRouter(prefix="/api/usage", tags=["usage"])


@router.get("/summary", response_model=UsageSummaryResponse)
async def get_summary(user: CurrentUser = Depends(get_current_user)) -> UsageSummaryResponse:
    return service.get_summary(user)


@router.post("/assert-render-cap", status_code=204)
async def assert_render_cap(user: CurrentUser = Depends(get_current_user)) -> None:
    """Called by frontend/src/app/api/render/route.ts (a different runtime,
    same permission/cap source of truth) before it will trigger a
    Creatomate render -- see service.assert_render_cap."""
    service.assert_render_cap(user)
