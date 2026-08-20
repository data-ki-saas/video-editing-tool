from abc import ABC, abstractmethod


class LLMProvider(ABC):
    """A chat-completion backend. Implementations wrap a specific vendor's API
    behind this one method, so callers (e.g. niche-config generation) don't
    depend on any provider's SDK or request/response shape directly.
    """

    @abstractmethod
    async def complete(self, prompt: str, *, system: str | None = None, max_tokens: int = 1024) -> str:
        """Send a single-turn prompt and return the model's text response."""
