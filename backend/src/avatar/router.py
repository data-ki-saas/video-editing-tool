from fastapi import APIRouter, Depends, Request, Response

from src.avatar import service
from src.avatar.schemas import (
    AvatarGenerationDetail,
    AvatarOptionsResponse,
    GenerateAvatarVideoRequest,
    GenerateAvatarVideoResponse,
)
from src.core.auth import CurrentUser, get_current_user

router = APIRouter(prefix="/api/avatar", tags=["avatar"])


@router.get("/avatars", response_model=AvatarOptionsResponse)
async def list_avatars(user: CurrentUser = Depends(get_current_user)) -> AvatarOptionsResponse:
    return AvatarOptionsResponse(avatars=await service.list_avatars())


@router.post("/generate", response_model=GenerateAvatarVideoResponse, status_code=201)
async def generate(
    body: GenerateAvatarVideoRequest, user: CurrentUser = Depends(get_current_user)
) -> GenerateAvatarVideoResponse:
    return await service.generate(body.project_id, body.audio_asset_id, body.avatar_id, user)


@router.get("/generations/{id}", response_model=AvatarGenerationDetail)
async def get_generation(id: str, user: CurrentUser = Depends(get_current_user)) -> AvatarGenerationDetail:
    return service.get_generation(id, user)


# No get_current_user dependency: this is called by HeyGen's servers, not a
# signed-in user -- see service.handle_webhook/HeyGenProvider.verify_webhook
# for the actual authentication (a shared secret in the callback URL's own
# query string, checked against the request body's raw bytes).
@router.post("/webhooks/heygen", status_code=200)
async def heygen_webhook(request: Request) -> Response:
    raw_body = await request.body()
    await service.handle_webhook(
        raw_body=raw_body,
        headers=dict(request.headers),
        query_secret=request.query_params.get("secret"),
    )
    return Response(status_code=200)
