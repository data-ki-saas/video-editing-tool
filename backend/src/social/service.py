import hashlib
import hmac
import logging
import time
from datetime import datetime, timedelta, timezone

from fastapi import BackgroundTasks, HTTPException

from src.core.auth import CurrentUser
from src.core.config import settings
from src.library import repository as library_repository
from src.social import repository as social_repository
from src.social.client import get_social_provider
from src.social.schemas import (
    ConnectUrlResponse,
    PublishResponse,
    SocialAccountResponse,
    SocialAccountsResponse,
    SocialPostDetail,
)

logger = logging.getLogger(__name__)

_STATE_TTL_SECONDS = 900  # 15 minutes -- long enough for a real consent flow, short enough to limit replay
_TOKEN_REFRESH_MARGIN_SECONDS = 60


def _sign_state(user_id: str) -> str:
    nonce = f"{user_id}:{int(time.time())}"
    signature = hmac.new(settings.social_oauth_state_secret.encode(), nonce.encode(), hashlib.sha256).hexdigest()
    return f"{nonce}:{signature}"


def _verify_state(state: str) -> str:
    """Returns the user_id embedded in a connect-url's state param, or
    raises -- the OAuth callback has no bearer token/session of its own
    (Google redirects the browser here directly), so this signed value is
    the only thing identifying who started the connect flow. Same
    self-generated-shared-secret precedent as CREATOMATE_WEBHOOK_SECRET,
    adapted for CSRF state instead of a webhook signature."""
    try:
        user_id, issued_at, signature = state.rsplit(":", 2)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid state") from None
    expected = hmac.new(
        settings.social_oauth_state_secret.encode(), f"{user_id}:{issued_at}".encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=400, detail="Invalid state")
    if time.time() - float(issued_at) > _STATE_TTL_SECONDS:
        raise HTTPException(status_code=400, detail="This connection attempt expired -- try again")
    return user_id


def get_connect_url(provider: str, user: CurrentUser) -> ConnectUrlResponse:
    if not settings.social_oauth_state_secret:
        raise HTTPException(status_code=500, detail="Social posting isn't configured on this server yet")
    state = _sign_state(user.id)
    try:
        url = get_social_provider(provider).get_authorize_url(state)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return ConnectUrlResponse(url=url)


async def handle_callback(provider: str, code: str | None, state: str | None, error: str | None) -> str:
    """Returns the frontend URL to redirect the browser to. Deliberately
    never raises past a verified state: a failed token exchange still lands
    the user back on /settings with a readable `social_error` instead of a
    raw 500 page, since there's no in-app UI to show an error on otherwise
    (Google, not our frontend, is what's redirecting here)."""
    frontend_settings_url = f"{settings.frontend_public_url.rstrip('/')}/settings"
    if error:
        return f"{frontend_settings_url}?social_error={error}"
    if not code or not state:
        return f"{frontend_settings_url}?social_error=missing_code"

    # Still raises HTTPException -- a forged/expired state isn't a normal
    # "user declined consent" case and shouldn't be swallowed the same way.
    user_id = _verify_state(state)

    try:
        provider_client = get_social_provider(provider)
        tokens = await provider_client.exchange_code(code)
        account_info = await provider_client.get_account_info(tokens.access_token)
    except Exception:
        logger.exception("social connect failed for provider=%s user=%s", provider, user_id)
        return f"{frontend_settings_url}?social_error=connect_failed"

    expires_at = datetime.now(timezone.utc) + timedelta(seconds=tokens.expires_in_seconds)
    social_repository.upsert_account(
        user_id=user_id,
        provider=provider,
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        token_expires_at=expires_at.isoformat(),
        account_id=account_info.account_id,
        account_name=account_info.account_name,
    )
    return f"{frontend_settings_url}?social=connected&provider={provider}"


def list_accounts(user: CurrentUser) -> SocialAccountsResponse:
    records = social_repository.list_accounts(user.id)
    return SocialAccountsResponse(
        accounts=[
            SocialAccountResponse(provider=r.provider, account_name=r.account_name, connected_at=r.created_at)
            for r in records
        ]
    )


def disconnect(provider: str, user: CurrentUser) -> None:
    record = social_repository.delete_account(user.id, provider)
    if record is None:
        raise HTTPException(status_code=404, detail="No connected account for that platform")


async def _ensure_fresh_token(provider: str, account: social_repository.SocialAccountRecord) -> str:
    expires_at = datetime.fromisoformat(account.token_expires_at)
    if datetime.now(timezone.utc) < expires_at - timedelta(seconds=_TOKEN_REFRESH_MARGIN_SECONDS):
        return account.access_token
    tokens = await get_social_provider(provider).refresh_access_token(account.refresh_token)
    new_expires_at = datetime.now(timezone.utc) + timedelta(seconds=tokens.expires_in_seconds)
    social_repository.update_tokens(
        account.id,
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        token_expires_at=new_expires_at.isoformat(),
    )
    return tokens.access_token


async def _run_publish(post_id: str, provider: str, access_token: str, video_url: str, title: str, description: str) -> None:
    """Runs as a FastAPI background task, after the 202 response for
    `publish` below has already been sent -- same accepted "basic version,
    no durable queue" tradeoff the render-transfer-worker's own README
    section documents, kept in-process rather than standing up a real queue
    for a POC-scale feature."""
    try:
        provider_video_id = await get_social_provider(provider).publish_video(
            access_token=access_token, video_url=video_url, title=title, description=description
        )
    except Exception as exc:
        logger.exception("publish to %s failed for post=%s", provider, post_id)
        social_repository.mark_post_failed(post_id, str(exc))
        return
    provider_url = f"https://youtube.com/watch?v={provider_video_id}" if provider == "youtube" else provider_video_id
    social_repository.mark_post_completed(post_id, provider_video_id=provider_video_id, provider_url=provider_url)


async def publish(
    provider: str,
    library_video_id: str,
    title: str,
    description: str,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
) -> PublishResponse:
    video = library_repository.get_owned(library_video_id, user.id)
    if video is None:
        raise HTTPException(status_code=404, detail="Library video not found")

    account = social_repository.get_account(user.id, provider)
    if account is None:
        raise HTTPException(status_code=400, detail=f"Connect a {provider} account in Settings first")

    try:
        access_token = await _ensure_fresh_token(provider, account)
    except Exception as exc:
        logger.exception("token refresh failed for provider=%s user=%s", provider, user.id)
        raise HTTPException(
            status_code=502, detail="Couldn't refresh your connected account -- try reconnecting it in Settings"
        ) from exc

    post = social_repository.create_post(library_video_id=library_video_id, user_id=user.id, provider=provider)
    background_tasks.add_task(_run_publish, post.id, provider, access_token, video.video_url, title, description)
    return PublishResponse(id=post.id, status="processing")


def get_post(id: str, user: CurrentUser) -> SocialPostDetail:
    record = social_repository.get_post(id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Post not found")
    return SocialPostDetail(id=record.id, status=record.status, provider_url=record.provider_url, error=record.error)
