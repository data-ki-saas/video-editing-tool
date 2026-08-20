from functools import lru_cache

from src.core.config import settings
from src.llm.providers.anthropic_provider import AnthropicProvider
from src.llm.providers.base import LLMProvider
from src.llm.providers.deepseek_provider import DeepSeekProvider

_PROVIDERS = {"anthropic", "deepseek"}


@lru_cache
def get_llm_provider() -> LLMProvider:
    if settings.llm_provider == "deepseek":
        return DeepSeekProvider(api_key=settings.deepseek_api_key, model=settings.deepseek_model)
    if settings.llm_provider == "anthropic":
        return AnthropicProvider(api_key=settings.anthropic_api_key, model=settings.anthropic_model)
    raise ValueError(
        f"Unknown LLM provider {settings.llm_provider!r}; expected one of {sorted(_PROVIDERS)}"
    )
