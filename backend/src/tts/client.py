from functools import lru_cache

from src.core.config import settings
from src.tts.providers.base import TTSProvider
from src.tts.providers.edge_provider import EdgeTTSProvider
from src.tts.providers.sarvam_provider import SarvamTTSProvider, is_sarvam_voice

_PROVIDERS = {"edge", "sarvam"}


@lru_cache
def _get_provider(name: str) -> TTSProvider:
    if name == "edge":
        return EdgeTTSProvider()
    if name == "sarvam":
        return SarvamTTSProvider()
    raise ValueError(f"Unknown TTS provider {name!r}; expected one of {sorted(_PROVIDERS)}")


def get_tts_provider(voice: str | None = None) -> TTSProvider:
    """The provider that renders `voice` -- voice ids are globally unique, so a
    Sarvam voice id routes to Sarvam and anything else to the configured
    default (settings.tts_provider, the free edge-tts voices)."""
    if voice is not None and is_sarvam_voice(voice):
        return _get_provider("sarvam")
    return _get_provider(settings.tts_provider)


def sarvam_enabled() -> bool:
    return bool(settings.sarvam_api_key)
