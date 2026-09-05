import logging
import urllib.parse

import httpx

from src.social.providers.base import OAuthTokens, SocialAccountInfo, SocialProvider

logger = logging.getLogger(__name__)

_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels"
_UPLOAD_INIT_URL = "https://www.googleapis.com/upload/youtube/v3/videos"

# youtube.upload alone already covers the channels.list?mine=true call
# get_account_info makes (to show which channel got connected) -- requesting
# a second, narrower scope for that would just mean a second consent
# screen for no real benefit.
_SCOPE = "https://www.googleapis.com/auth/youtube.upload"

# NOT verified against a live Google account (none available while wiring
# this up) -- same caveat this app's HeyGenProvider/FalVeedProvider already
# carry for their own webhook payloads. Before relying on this in
# production, confirm against a real OAuth consent + upload: the resumable-
# upload request/response shape here follows Google's published Data API v3
# docs (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol).


def _raise_for_status(response: httpx.Response) -> None:
    # Same reasoning as matting/providers/fal_veed_provider.py's own
    # _raise_for_status: httpx's default error message omits the response
    # body, which is exactly where Google puts the actually-useful reason
    # (e.g. "invalid_grant" for a revoked/expired refresh token).
    if response.is_error:
        logger.error(
            "YouTube/Google API request to %s failed: %s -- %s",
            response.url,
            response.status_code,
            response.text[:2000],
        )
    response.raise_for_status()


class YouTubeProvider(SocialProvider):
    def __init__(self, *, client_id: str, client_secret: str, redirect_uri: str):
        self._client_id = client_id
        self._client_secret = client_secret
        self._redirect_uri = redirect_uri

    def _require_configured(self) -> None:
        if not self._client_id or not self._client_secret:
            raise ValueError("YouTube isn't configured on this server yet (GOOGLE_OAUTH_CLIENT_ID/_SECRET are empty).")

    def get_authorize_url(self, state: str) -> str:
        self._require_configured()
        params = {
            "client_id": self._client_id,
            "redirect_uri": self._redirect_uri,
            "response_type": "code",
            "scope": _SCOPE,
            "access_type": "offline",
            # Forces Google to re-issue a refresh_token even on a returning
            # user's second connect -- without this, Google only sends one
            # on a user's FIRST-ever consent for this client, which would
            # silently break reconnecting after a disconnect.
            "prompt": "consent",
            "state": state,
        }
        return f"{_AUTH_URL}?{urllib.parse.urlencode(params)}"

    async def exchange_code(self, code: str) -> OAuthTokens:
        self._require_configured()
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                _TOKEN_URL,
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "code": code,
                    "grant_type": "authorization_code",
                    "redirect_uri": self._redirect_uri,
                },
            )
        _raise_for_status(response)
        body = response.json()
        refresh_token = body.get("refresh_token")
        if not refresh_token:
            # Can happen if a user had already granted this app consent once
            # before and prompt=consent somehow didn't force a re-issue --
            # surfaced as a clear error rather than silently storing an
            # account that can never be refreshed past its first hour.
            raise ValueError("Google didn't return a refresh token -- disconnect and reconnect this account")
        return OAuthTokens(
            access_token=body["access_token"], refresh_token=refresh_token, expires_in_seconds=body["expires_in"]
        )

    async def refresh_access_token(self, refresh_token: str) -> OAuthTokens:
        self._require_configured()
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                _TOKEN_URL,
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "refresh_token": refresh_token,
                    "grant_type": "refresh_token",
                },
            )
        _raise_for_status(response)
        body = response.json()
        # Google's refresh response never includes a new refresh_token -- the
        # original one stays valid and keeps being reused (see
        # social/service.py's _ensure_fresh_token, which preserves it as-is).
        return OAuthTokens(
            access_token=body["access_token"], refresh_token=refresh_token, expires_in_seconds=body["expires_in"]
        )

    async def get_account_info(self, access_token: str) -> SocialAccountInfo:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                _CHANNELS_URL,
                params={"part": "snippet", "mine": "true"},
                headers={"Authorization": f"Bearer {access_token}"},
            )
        _raise_for_status(response)
        items = response.json().get("items") or []
        if not items:
            raise ValueError("This Google account has no YouTube channel to connect")
        channel = items[0]
        return SocialAccountInfo(account_id=channel["id"], account_name=channel["snippet"]["title"])

    async def publish_video(self, *, access_token: str, video_url: str, title: str, description: str) -> str:
        headers = {"Authorization": f"Bearer {access_token}"}

        async with httpx.AsyncClient(timeout=30) as client:
            head_response = await client.head(video_url)
        _raise_for_status(head_response)
        content_length = head_response.headers.get("content-length")
        if not content_length:
            raise ValueError(f"Couldn't determine the video's size from {video_url}")

        async with httpx.AsyncClient(timeout=30) as client:
            init_response = await client.post(
                _UPLOAD_INIT_URL,
                params={"uploadType": "resumable", "part": "snippet,status"},
                headers={
                    **headers,
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-Upload-Content-Type": "video/mp4",
                    "X-Upload-Content-Length": content_length,
                },
                json={
                    "snippet": {"title": title, "description": description},
                    # "public" is the deliberate default -- the entire point
                    # of this feature is a one-click PUBLISH, not a draft the
                    # user has to go find in YouTube Studio and manually flip
                    # to public afterward.
                    "status": {"privacyStatus": "public", "selfDeclaredMadeForKids": False},
                },
            )
        _raise_for_status(init_response)
        upload_session_url = init_response.headers.get("location")
        if not upload_session_url:
            raise ValueError("YouTube's upload-init response had no Location header")

        # Streams the video straight from our own R2 URL into YouTube's
        # upload session without ever buffering the whole file in this
        # process's memory -- the same "don't hold a multi-hundred-MB video
        # in RAM" concern this repo's worker/ service was built around (see
        # README.md's "Delivering finished videos"). Single-request upload
        # (no chunking/resume-on-failure) -- a v1 simplification, same
        # accepted "basic version, worth upgrading before real traffic"
        # tradeoff the render-transfer-worker's own README section states.
        async with httpx.AsyncClient(timeout=None) as source_client:
            async with source_client.stream("GET", video_url) as source_response:
                _raise_for_status(source_response)
                async with httpx.AsyncClient(timeout=None) as upload_client:
                    upload_response = await upload_client.put(
                        upload_session_url,
                        headers={"Content-Type": "video/mp4", "Content-Length": content_length},
                        content=source_response.aiter_bytes(),
                    )
        _raise_for_status(upload_response)
        video_id = upload_response.json().get("id")
        if not video_id:
            raise ValueError(f"YouTube upload response had no video id: {upload_response.json()!r}")
        return video_id
