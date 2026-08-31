from functools import lru_cache

from src.core.config import settings
from src.matting.providers.base import MattingProvider
from src.matting.providers.fal_veed_provider import FalVeedProvider

_PROVIDERS = {"fal_veed"}


@lru_cache
def get_matting_provider() -> MattingProvider:
    if settings.matting_provider == "fal_veed":
        return FalVeedProvider(api_key=settings.fal_api_key, webhook_secret=settings.fal_webhook_secret)
    raise ValueError(f"Unknown matting provider {settings.matting_provider!r}; expected one of {sorted(_PROVIDERS)}")
