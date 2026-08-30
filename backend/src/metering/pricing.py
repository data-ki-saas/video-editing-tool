from src.core.config import settings


def render_cost_cents(duration_seconds: float) -> float:
    return duration_seconds * settings.creatomate_cost_cents_per_second


def avatar_cost_cents(duration_seconds: float) -> float:
    return duration_seconds * settings.heygen_cost_cents_per_second


def voiceover_cost_cents(duration_seconds: float) -> float:
    return duration_seconds * settings.tts_cost_cents_per_second


def llm_cost_cents(provider: str, prompt_tokens: int, completion_tokens: int) -> float:
    if provider == "deepseek":
        return (prompt_tokens + completion_tokens) / 1000 * settings.deepseek_cost_cents_per_1k_tokens
    if provider == "anthropic":
        return (
            prompt_tokens / 1000 * settings.anthropic_cost_cents_per_1k_input_tokens
            + completion_tokens / 1000 * settings.anthropic_cost_cents_per_1k_output_tokens
        )
    return 0.0
