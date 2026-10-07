from fastapi import APIRouter, Depends

from src.assets.schemas import AssetInfo
from src.core.auth import CurrentUser, get_current_user, require_feature
from src.png_search import service
from src.png_search.schemas import ImportPngRequest, PngSearchResponse

router = APIRouter(
    prefix="/api/png-search", tags=["png-search"], dependencies=[Depends(require_feature("stock_media_use"))]
)


@router.get("/search", response_model=PngSearchResponse)
async def search_png(query: str, page: int = 1, user: CurrentUser = Depends(get_current_user)) -> PngSearchResponse:
    return await service.search_png(query, page)


@router.post("/import", response_model=AssetInfo, status_code=201)
async def import_png(body: ImportPngRequest, user: CurrentUser = Depends(get_current_user)) -> AssetInfo:
    return await service.import_png(body.project_id, body.source_id, body.title, user)
