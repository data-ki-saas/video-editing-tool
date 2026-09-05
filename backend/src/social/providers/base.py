from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class OAuthTokens:
    access_token: str
    refresh_token: str
    expires_in_seconds: int


@dataclass
class SocialAccountInfo:
    account_id: str
    account_name: str


class SocialProvider(ABC):
    """One connected social platform: OAuth connect + publishing a video
    that already lives at a durable, publicly-fetchable URL (this app's own
    R2-hosted library_videos.video_url). Mirrors avatar/providers/base.py's
    AvatarProvider shape -- callers (social/service.py) never depend on a
    specific vendor's SDK or token format.

    Unlike AvatarProvider (one active vendor at a time, switched via a
    global settings.avatar_provider), a user can have several
    SocialProviders connected simultaneously, so this is looked up by name
    per-request rather than through a single settings switch -- see
    social/client.py's get_social_provider.
    """

    @abstractmethod
    def get_authorize_url(self, state: str) -> str:
        """The URL to send the browser to for this platform's consent
        screen -- `state` is round-tripped back verbatim to the callback."""

    @abstractmethod
    async def exchange_code(self, code: str) -> OAuthTokens:
        """Trades a one-time authorization code (from the callback redirect)
        for a real access/refresh token pair."""

    @abstractmethod
    async def refresh_access_token(self, refresh_token: str) -> OAuthTokens:
        """Mints a fresh access token once the stored one has expired."""

    @abstractmethod
    async def get_account_info(self, access_token: str) -> SocialAccountInfo:
        """Identifies which account was just connected (e.g. the YouTube
        channel id/title) -- shown in Settings so a user can tell which
        account is linked."""

    @abstractmethod
    async def publish_video(self, *, access_token: str, video_url: str, title: str, description: str) -> str:
        """Uploads the video at `video_url` (our own durable R2 URL) to this
        platform and returns the platform's own video id."""
