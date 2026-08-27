from functools import lru_cache

from src.core.config import settings
from src.tts.providers.base import TTSProvider
from src.tts.providers.edge_provider import EdgeTTSProvider

_PROVIDERS = {"edge"}


@lru_cache
def get_tts_provider() -> TTSProvider:
    if settings.tts_provider == "edge":
        return EdgeTTSProvider()
    raise ValueError(f"Unknown TTS provider {settings.tts_provider!r}; expected one of {sorted(_PROVIDERS)}")
