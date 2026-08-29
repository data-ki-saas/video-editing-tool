from functools import lru_cache

from src.avatar.providers.base import AvatarProvider
from src.avatar.providers.heygen_provider import HeyGenProvider
from src.core.config import settings

_PROVIDERS = {"heygen"}


@lru_cache
def get_avatar_provider() -> AvatarProvider:
    if settings.avatar_provider == "heygen":
        return HeyGenProvider(api_key=settings.heygen_api_key, webhook_secret=settings.heygen_webhook_secret)
    raise ValueError(f"Unknown avatar provider {settings.avatar_provider!r}; expected one of {sorted(_PROVIDERS)}")
