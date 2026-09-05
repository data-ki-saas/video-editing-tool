from functools import lru_cache

from src.core.config import settings
from src.social.providers.base import SocialProvider
from src.social.providers.youtube_provider import YouTubeProvider

_PROVIDERS = {"youtube"}


@lru_cache
def get_social_provider(provider: str) -> SocialProvider:
    """Keyed by the route's own `provider` path param, unlike
    avatar/matting's get_x_provider() (a single global settings switch) --
    a user can have several platforms connected at once here, so this is a
    small registry instead. `_PROVIDERS = {"youtube"}` today; add meta/tiktok
    here later without changing any caller."""
    if provider == "youtube":
        return YouTubeProvider(
            client_id=settings.google_oauth_client_id,
            client_secret=settings.google_oauth_client_secret,
            redirect_uri=f"{settings.backend_public_url.rstrip('/')}/api/social/youtube/callback",
        )
    raise ValueError(f"Unknown social provider {provider!r}; expected one of {sorted(_PROVIDERS)}")
