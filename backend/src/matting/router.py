from fastapi import APIRouter, Depends, Request, Response

from src.core.auth import CurrentUser, get_current_user, require_feature
from src.matting import service
from src.matting.schemas import BackgroundRemovalDetail, RequestBackgroundRemovalRequest, RequestBackgroundRemovalResponse

router = APIRouter(prefix="/api/matting", tags=["matting"])


@router.post("/request", response_model=RequestBackgroundRemovalResponse, status_code=201)
async def request_background_removal(
    body: RequestBackgroundRemovalRequest, user: CurrentUser = Depends(require_feature("matting_generate"))
) -> RequestBackgroundRemovalResponse:
    return await service.request(body.project_id, body.source_asset_id, user)


@router.get("/status/{source_asset_id}", response_model=BackgroundRemovalDetail)
async def get_status(source_asset_id: str, user: CurrentUser = Depends(get_current_user)) -> BackgroundRemovalDetail:
    return service.get_status(source_asset_id, user)


# No get_current_user dependency: this is called by fal's servers, not a
# signed-in user -- see service.handle_webhook/FalVeedProvider.verify_webhook
# for the actual authentication.
@router.post("/webhooks/fal", status_code=200)
async def fal_webhook(request: Request) -> Response:
    raw_body = await request.body()
    await service.handle_webhook(
        raw_body=raw_body,
        headers=dict(request.headers),
        query_secret=request.query_params.get("secret"),
    )
    return Response(status_code=200)
