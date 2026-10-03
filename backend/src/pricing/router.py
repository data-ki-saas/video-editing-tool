from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, require_feature
from src.pricing import service
from src.pricing.schemas import PricingResponse, SetPriceRequest

router = APIRouter(prefix="/api/admin/pricing", tags=["admin-pricing"])

_require_pricing = require_feature("pricing_manage")


@router.get("", response_model=PricingResponse)
async def list_pricing(user: CurrentUser = Depends(_require_pricing)) -> PricingResponse:
    return service.list_pricing()


@router.put("/{resource_key}", response_model=PricingResponse)
async def set_price(
    resource_key: str, body: SetPriceRequest, user: CurrentUser = Depends(_require_pricing)
) -> PricingResponse:
    return service.set_price(resource_key, body.unit_price_cents, user)
