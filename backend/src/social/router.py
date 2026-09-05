from fastapi import APIRouter, BackgroundTasks, Depends
from fastapi.responses import RedirectResponse

from src.core.auth import CurrentUser, get_current_user, require_feature
from src.social import service
from src.social.schemas import (
    ConnectUrlResponse,
    PublishRequest,
    PublishResponse,
    SocialAccountsResponse,
    SocialPostDetail,
)

router = APIRouter(prefix="/api/social", tags=["social"])


@router.get("/accounts", response_model=SocialAccountsResponse)
async def list_accounts(user: CurrentUser = Depends(get_current_user)) -> SocialAccountsResponse:
    return service.list_accounts(user)


@router.get("/{provider}/connect-url", response_model=ConnectUrlResponse)
async def connect_url(provider: str, user: CurrentUser = Depends(get_current_user)) -> ConnectUrlResponse:
    return service.get_connect_url(provider, user)


# No get_current_user dependency: Google redirects the browser here
# directly after the consent screen, with no bearer token to send -- the
# signed `state` param IS the authentication for who initiated this (see
# service._verify_state).
@router.get("/{provider}/callback")
async def callback(
    provider: str, code: str | None = None, state: str | None = None, error: str | None = None
) -> RedirectResponse:
    redirect_url = await service.handle_callback(provider, code, state, error)
    return RedirectResponse(redirect_url)


@router.post("/{provider}/disconnect", status_code=204)
async def disconnect(provider: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.disconnect(provider, user)


@router.post("/{provider}/publish", response_model=PublishResponse, status_code=202)
async def publish(
    provider: str,
    body: PublishRequest,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(require_feature("social_posting")),
) -> PublishResponse:
    return await service.publish(provider, body.library_video_id, body.title, body.description, user, background_tasks)


@router.get("/posts/{id}", response_model=SocialPostDetail)
async def get_post(id: str, user: CurrentUser = Depends(get_current_user)) -> SocialPostDetail:
    return service.get_post(id, user)
