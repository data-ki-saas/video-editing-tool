import asyncio
import logging
import urllib.parse
from typing import Literal

import httpx

from src.social.providers.base import OAuthTokens, SocialAccountInfo, SocialProvider

logger = logging.getLogger(__name__)

_API_VERSION = "v21.0"
_AUTH_URL = f"https://www.facebook.com/{_API_VERSION}/dialog/oauth"
_GRAPH_URL = f"https://graph.facebook.com/{_API_VERSION}"

# Requested together in one consent so a single "Connect Facebook" click
# (see service.py's handle_callback) can discover both a Page and its
# linked Instagram Business account in one shot -- matches the permissions
# table in META_APP_REVIEW.md exactly.
_SCOPE = "pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish"

_LONG_LIVED_TOKEN_FALLBACK_SECONDS = 60 * 24 * 3600  # Meta's own long-lived user tokens run ~60 days
_CONTAINER_POLL_ATTEMPTS = 10
_CONTAINER_POLL_INTERVAL_SECONDS = 3

# NOT verified against a live Meta app/Page/Instagram Business account (none
# available while wiring this up -- see META_APP_REVIEW.md's prerequisites
# checklist). Same caveat youtube_provider.py's own comment carries for its
# resumable upload: this follows Meta's published Graph API docs
# (https://developers.facebook.com/docs/graph-api/guides/video-uploads,
# https://developers.facebook.com/docs/instagram-api/guides/content-publishing)
# but confirm against a real consent + publish before relying on it in
# production.


def _raise_for_status(response: httpx.Response) -> None:
    # Same reasoning as youtube_provider.py's own _raise_for_status: httpx's
    # default error message omits the response body, which is exactly where
    # Graph API puts the actually-useful reason (e.g. an OAuthException with
    # a human-readable message for an expired/invalid token).
    if response.is_error:
        logger.error(
            "Meta Graph API request to %s failed: %s -- %s",
            response.url,
            response.status_code,
            response.text[:2000],
        )
    response.raise_for_status()


class MetaProvider(SocialProvider):
    """One Meta app serves two provider keys -- `meta` (the Facebook Page)
    and `instagram` (its linked Instagram Business account); see client.py's
    registry. Only `meta` ever starts the OAuth flow (Settings has one
    "Connect Facebook" button, not a separate "Connect Instagram" one --
    Meta's Graph API has no separate Instagram login): the `instagram` row
    is created transparently by service.py's handle_callback via
    get_linked_instagram_account below, reusing the same Page token. This
    class still handles both keys for refresh/disconnect/publish so each
    account row can be managed (and posted to) independently once connected.
    `platform` only changes get_account_info/publish_video's target -- the
    OAuth/token dance is identical either way.
    """

    def __init__(self, *, app_id: str, app_secret: str, redirect_uri: str, platform: Literal["meta", "instagram"]):
        self._app_id = app_id
        self._app_secret = app_secret
        self._redirect_uri = redirect_uri
        self._platform = platform

    def _require_configured(self) -> None:
        if not self._app_id or not self._app_secret:
            raise ValueError("Meta/Facebook isn't configured on this server yet (META_APP_ID/_SECRET are empty).")

    def get_authorize_url(self, state: str) -> str:
        self._require_configured()
        params = {
            "client_id": self._app_id,
            "redirect_uri": self._redirect_uri,
            "response_type": "code",
            "scope": _SCOPE,
            "state": state,
        }
        return f"{_AUTH_URL}?{urllib.parse.urlencode(params)}"

    async def exchange_code(self, code: str) -> OAuthTokens:
        self._require_configured()
        short_lived_token = await self._exchange_code_for_short_lived_token(code)
        user_token, expires_in_seconds = await self._exchange_for_long_lived_user_token(short_lived_token)
        _, page_token = await self._first_page_token(user_token)
        # The long-lived USER token is stored as our `refresh_token` -- it's
        # what refresh_access_token re-derives a fresh Page token from later
        # (Meta has no Google-style rotating refresh grant). The PAGE token
        # is stored as `access_token` since that's what publish_video/
        # get_account_info actually authenticate with.
        return OAuthTokens(access_token=page_token, refresh_token=user_token, expires_in_seconds=expires_in_seconds)

    async def _exchange_code_for_short_lived_token(self, code: str) -> str:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"{_GRAPH_URL}/oauth/access_token",
                params={
                    "client_id": self._app_id,
                    "client_secret": self._app_secret,
                    "redirect_uri": self._redirect_uri,
                    "code": code,
                },
            )
        _raise_for_status(response)
        return response.json()["access_token"]

    async def _exchange_for_long_lived_user_token(self, short_lived_token: str) -> tuple[str, int]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"{_GRAPH_URL}/oauth/access_token",
                params={
                    "grant_type": "fb_exchange_token",
                    "client_id": self._app_id,
                    "client_secret": self._app_secret,
                    "fb_exchange_token": short_lived_token,
                },
            )
        _raise_for_status(response)
        body = response.json()
        return body["access_token"], body.get("expires_in", _LONG_LIVED_TOKEN_FALLBACK_SECONDS)

    async def _first_page_token(self, user_access_token: str) -> tuple[str, str]:
        # Same "take the first one" v1 simplification youtube_provider.py's
        # get_account_info already uses for channels -- a picker across
        # several managed Pages can follow later if that turns out to matter.
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"{_GRAPH_URL}/me/accounts",
                params={"fields": "id,name,access_token", "access_token": user_access_token},
            )
        _raise_for_status(response)
        pages = response.json().get("data") or []
        if not pages:
            raise ValueError("This Facebook account manages no Pages to connect")
        page = pages[0]
        return page["id"], page["access_token"]

    async def refresh_access_token(self, refresh_token: str) -> OAuthTokens:
        self._require_configured()
        # `refresh_token` here is the long-lived USER token stored at
        # connect time -- re-fetching /me/accounts with it mints a fresh
        # Page token without needing a new user consent. If the user token
        # itself has actually expired (~60 days with no re-auth), this
        # raises and service.py's _ensure_fresh_token surfaces it as
        # "reconnect your account" -- Meta has no way to extend a user
        # token past its own expiry short of a new login.
        _, page_token = await self._first_page_token(refresh_token)
        return OAuthTokens(
            access_token=page_token, refresh_token=refresh_token, expires_in_seconds=_LONG_LIVED_TOKEN_FALLBACK_SECONDS
        )

    async def get_account_info(self, access_token: str) -> SocialAccountInfo:
        if self._platform == "instagram":
            ig_account = await self.get_linked_instagram_account(access_token)
            if ig_account is None:
                raise ValueError("This Facebook Page has no linked Instagram Business account")
            return ig_account
        # Hitting /me with a PAGE access token (not a user token) returns
        # that Page's own id/name -- no separate page-id lookup needed.
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(f"{_GRAPH_URL}/me", params={"fields": "id,name", "access_token": access_token})
        _raise_for_status(response)
        body = response.json()
        return SocialAccountInfo(account_id=body["id"], account_name=body["name"])

    async def get_linked_instagram_account(self, page_access_token: str) -> SocialAccountInfo | None:
        """Not on the SocialProvider ABC -- only service.py's handle_callback
        calls this, right after a `meta` connect, to transparently also
        connect the Page's linked Instagram Business account in the same
        step (see META_APP_REVIEW.md's demo script: one "Connect Facebook"
        click surfaces both). Returns None if the Page has no linked IG
        Business account."""
        async with httpx.AsyncClient(timeout=30) as client:
            page_response = await client.get(
                f"{_GRAPH_URL}/me",
                params={"fields": "instagram_business_account", "access_token": page_access_token},
            )
        _raise_for_status(page_response)
        ig_account = page_response.json().get("instagram_business_account")
        if not ig_account:
            return None
        ig_id = ig_account["id"]
        async with httpx.AsyncClient(timeout=30) as client:
            username_response = await client.get(
                f"{_GRAPH_URL}/{ig_id}", params={"fields": "username", "access_token": page_access_token}
            )
        _raise_for_status(username_response)
        return SocialAccountInfo(account_id=ig_id, account_name=username_response.json()["username"])

    async def publish_video(self, *, access_token: str, video_url: str, title: str, description: str) -> str:
        if self._platform == "instagram":
            return await self._publish_to_instagram(access_token, video_url, description or title)
        return await self._publish_to_page(access_token, video_url, title, description)

    async def _publish_to_page(self, page_access_token: str, video_url: str, title: str, description: str) -> str:
        # /me/videos, authenticated with the PAGE token, posts to that Page
        # directly -- publish_video's fixed signature (base.py) has no
        # account_id param, so this sidesteps needing the Page's id at all.
        async with httpx.AsyncClient(timeout=None) as client:
            response = await client.post(
                f"{_GRAPH_URL}/me/videos",
                data={
                    "access_token": page_access_token,
                    "file_url": video_url,
                    "title": title,
                    "description": description,
                },
            )
        _raise_for_status(response)
        video_id = response.json().get("id")
        if not video_id:
            raise ValueError(f"Facebook video-publish response had no video id: {response.json()!r}")
        return await self._permalink(video_id, page_access_token, field="permalink_url")

    async def _publish_to_instagram(self, page_access_token: str, video_url: str, caption: str) -> str:
        ig_account = await self.get_linked_instagram_account(page_access_token)
        if ig_account is None:
            raise ValueError("No Instagram Business account linked to the connected Facebook Page")

        async with httpx.AsyncClient(timeout=30) as client:
            container_response = await client.post(
                f"{_GRAPH_URL}/{ig_account.account_id}/media",
                data={
                    "access_token": page_access_token,
                    "video_url": video_url,
                    "caption": caption,
                    "media_type": "REELS",
                },
            )
        _raise_for_status(container_response)
        container_id = container_response.json().get("id")
        if not container_id:
            raise ValueError(f"Instagram media-container response had no id: {container_response.json()!r}")

        await self._wait_for_container_ready(container_id, page_access_token)

        async with httpx.AsyncClient(timeout=30) as client:
            publish_response = await client.post(
                f"{_GRAPH_URL}/{ig_account.account_id}/media_publish",
                data={"access_token": page_access_token, "creation_id": container_id},
            )
        _raise_for_status(publish_response)
        media_id = publish_response.json().get("id")
        if not media_id:
            raise ValueError(f"Instagram media-publish response had no id: {publish_response.json()!r}")
        return await self._permalink(media_id, page_access_token, field="permalink")

    async def _wait_for_container_ready(self, container_id: str, page_access_token: str) -> None:
        # Instagram processes the video asynchronously -- media_publish
        # fails until the container's status_code flips to FINISHED. Same
        # bounded-poll shape as this repo's own frontend pollSocialPost
        # (lib/socialPost.ts), just server-side and much shorter (Instagram's
        # own docs note most videos finish processing well under a minute).
        for _ in range(_CONTAINER_POLL_ATTEMPTS):
            async with httpx.AsyncClient(timeout=30) as client:
                status_response = await client.get(
                    f"{_GRAPH_URL}/{container_id}", params={"fields": "status_code", "access_token": page_access_token}
                )
            _raise_for_status(status_response)
            status_code = status_response.json().get("status_code")
            if status_code == "FINISHED":
                return
            if status_code == "ERROR":
                raise ValueError("Instagram failed to process this video")
            await asyncio.sleep(_CONTAINER_POLL_INTERVAL_SECONDS)
        raise ValueError("Instagram is still processing this video -- try posting again in a bit")

    async def _permalink(self, media_id: str, access_token: str, *, field: str) -> str:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(f"{_GRAPH_URL}/{media_id}", params={"fields": field, "access_token": access_token})
        _raise_for_status(response)
        url = response.json().get(field)
        if not url:
            raise ValueError(f"Meta Graph API didn't return a {field} for {media_id}")
        return url
