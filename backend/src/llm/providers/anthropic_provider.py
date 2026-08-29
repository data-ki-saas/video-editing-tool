from anthropic import AsyncAnthropic

from src.llm.providers.base import LLMProvider


class AnthropicProvider(LLMProvider):
    def __init__(self, *, api_key: str, model: str):
        self._api_key = api_key
        self._client = AsyncAnthropic(api_key=api_key)
        self._model = model

    async def complete(self, prompt: str, *, system: str | None = None, max_tokens: int = 1024) -> str:
        if not self._api_key:
            # Same reasoning as DeepSeekProvider's own check -- fail with an
            # obvious cause instead of whatever cryptic error an empty key
            # produces further down (a real incident: it read identically to
            # a truncated-JSON generation failure from the caller's side).
            raise ValueError("Anthropic API key is not configured (ANTHROPIC_API_KEY is empty).")

        response = await self._client.messages.create(
            model=self._model,
            max_tokens=max_tokens,
            system=system or "",
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(block.text for block in response.content if block.type == "text")
        if not text:
            # Every caller feeds this straight into json.loads() -- silently
            # returning "" here surfaces as an opaque "Expecting value: line 1
            # column 1 (char 0)" JSONDecodeError with no indication the LLM
            # call itself was the problem. Raising here instead means the
            # real cause reaches the caller directly.
            block_types = [block.type for block in response.content]
            raise ValueError(
                f"Anthropic response had no text content (stop_reason={response.stop_reason!r}, "
                f"content block types={block_types!r}) -- try again, or raise max_tokens if this "
                "keeps happening on larger prompts."
            )
        return text
