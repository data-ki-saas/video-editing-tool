from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class CompletionResult:
    text: str
    # None when a provider's response doesn't expose token usage -- callers
    # metering a completion should skip logging a usage_ledger row rather
    # than guess, same fail-soft posture as the rest of that module.
    prompt_tokens: int | None
    completion_tokens: int | None


class LLMProvider(ABC):
    """A chat-completion backend. Implementations wrap a specific vendor's API
    behind this one method, so callers (e.g. niche-config generation) don't
    depend on any provider's SDK or request/response shape directly.
    """

    @abstractmethod
    async def complete(self, prompt: str, *, system: str | None = None, max_tokens: int = 1024) -> CompletionResult:
        """Send a single-turn prompt and return the model's text response
        plus token usage (for metering), when the provider exposes it."""
