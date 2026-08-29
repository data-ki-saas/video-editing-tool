from fastapi import APIRouter, Depends

from src.assets.schemas import AssetInfo
from src.core.auth import CurrentUser, get_current_user, require_feature
from src.stock_media import service
from src.stock_media.schemas import ImportStockAssetRequest, StockMediaKind, StockSearchResponse

router = APIRouter(
    prefix="/api/stock-media", tags=["stock-media"], dependencies=[Depends(require_feature("stock_media_use"))]
)


@router.get("/search", response_model=StockSearchResponse)
async def search_stock_media(
    kind: StockMediaKind, query: str, page: int = 1, user: CurrentUser = Depends(get_current_user)
) -> StockSearchResponse:
    return await service.search_stock_media(kind, query, page)


@router.post("/import", response_model=AssetInfo, status_code=201)
async def import_stock_asset(
    body: ImportStockAssetRequest, user: CurrentUser = Depends(get_current_user)
) -> AssetInfo:
    return await service.import_stock_asset(body.project_id, body.kind, body.source_id, body.filename, user)
