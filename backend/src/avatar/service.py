import json
import logging

from fastapi import HTTPException

from src.avatar.schemas import AvatarActionBeat, DirectAvatarResponse
from src.core.config import settings
from src.llm.providers.base import LLMProvider
from src.metering import pricing as metering_pricing
from src.metering import repository as metering_repository

logger = logging.getLogger(__name__)

# Baseline every seed Topology implements (topology.ts's AvatarActionId) --
# used only as a defensive fallback if a caller ever sends an empty
# action_ids list (shouldn't happen: the frontend always sends the picked
# avatar's own resolved topology actions), same "never render nothing"
# posture as AvatarFramingDialog's own BASELINE_ACTION_IDS.
_BASELINE_ACTION_IDS = ["idle", "talk", "walk", "sit", "sleep", "lookAround"]


def _system_prompt(action_ids: list[str], duration_ms: int, duration_seconds: float) -> str:
    action_list = ", ".join(f'"{action_id}"' for action_id in action_ids)
    return (
        "You are directing a 2D cartoon avatar's actions to match a voiceover "
        f"script being read aloud over {duration_seconds:.1f} seconds. Given the "
        "script, respond with ONLY a JSON object with these keys:\n"
        f'"action_timeline": [{{"action": <one of: {action_list}>, "start_ms": '
        '<int>, "end_ms": <int>, "params": null}, ...] -- a sequence of beats, '
        "in ascending time order, that together span the full narration from "
        f'0 to {duration_ms} with NO gaps and NO overlaps (each beat\'s "end_ms" '
        'equals the next beat\'s "start_ms", the first beat\'s "start_ms" is 0, '
        f'the last beat\'s "end_ms" is {duration_ms}). Pick actions that match the '
        "tone and content of the words being spoken at that moment (e.g. a "
        'greeting or energetic line suits "talk"; a reflective pause or trailing '
        'thought suits "lookAround"; a long stretch of plain narration can stay '
        '"talk" throughout). Every beat\'s "action" MUST be exactly one of the '
        "allowed ids listed above -- never invent a new one.\n"
        '"director_note": <one short, plain-language sentence explaining the '
        "overall direction you chose, written for the person who wrote the "
        'script (e.g. "Had him look around during the pause before your '
        'call-to-action.")>.\n'
        "No markdown fences, no commentary."
    )


def _parse_action_timeline(raw: object, allowed_action_ids: set[str], duration_ms: int) -> list[AvatarActionBeat]:
    if not isinstance(raw, list):
        return []
    beats: list[AvatarActionBeat] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        action, start_ms, end_ms = entry.get("action"), entry.get("start_ms"), entry.get("end_ms")
        if not isinstance(action, str) or action not in allowed_action_ids:
            continue
        if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
            continue
        # Clamp into [0, duration_ms] rather than reject -- an LLM that's off
        # by a few ms at either end of the narration is a rounding quirk, not
        # a reason to drop an otherwise-good beat.
        clamped_start = max(0, min(int(start_ms), duration_ms))
        clamped_end = max(0, min(int(end_ms), duration_ms))
        if clamped_end <= clamped_start:
            continue
        params = entry.get("params")
        beats.append(
            AvatarActionBeat(
                action=action,
                start_ms=clamped_start,
                end_ms=clamped_end,
                params=params if isinstance(params, dict) else None,
            )
        )
    beats.sort(key=lambda beat: beat.start_ms)
    return beats


async def direct_avatar_actions(
    script: str,
    narration_duration_seconds: float,
    action_ids: list[str],
    user_id: str,
    provider: LLMProvider,
) -> DirectAvatarResponse:
    """Turns a narration script into a timed AvatarAction sequence -- same
    calling convention as niches/service.py's get_or_create_niche: one
    provider.complete() call against a system prompt enumerating the closed
    action vocabulary + exact JSON shape, json.loads wrapped in try/except
    that logs the raw response on failure, then metered as a usage event
    (abuse-rate-limiting, no billing, per project convention)."""
    duration_ms = max(1, round(narration_duration_seconds * 1000))
    allowed_action_ids = set(action_ids) if action_ids else set(_BASELINE_ACTION_IDS)

    response: str | None = None
    try:
        completion = await provider.complete(
            f"Script:\n{script.strip()}",
            system=_system_prompt(sorted(allowed_action_ids), duration_ms, narration_duration_seconds),
            max_tokens=1200,
        )
        response = completion.text
        parsed = json.loads(response)
    except Exception as exc:
        logger.exception("avatar direction failed; raw response: %r", response)
        raise HTTPException(status_code=502, detail="Couldn't direct this avatar -- try again") from exc

    if completion.prompt_tokens is not None and completion.completion_tokens is not None:
        metering_repository.record_event(
            user_id=user_id,
            event_type="llm_completion",
            provider=settings.llm_provider,
            quantity=completion.prompt_tokens + completion.completion_tokens,
            unit="tokens",
            cost_estimate_cents=metering_pricing.llm_cost_cents(
                settings.llm_provider, completion.prompt_tokens, completion.completion_tokens
            ),
            metadata={"feature": "avatar_direct"},
        )

    action_timeline = _parse_action_timeline(
        parsed.get("action_timeline") if isinstance(parsed, dict) else None, allowed_action_ids, duration_ms
    )
    if not action_timeline:
        logger.error("avatar direction returned an invalid shape: %r", parsed)
        raise HTTPException(status_code=502, detail="Couldn't direct this avatar -- try again")

    director_note = parsed.get("director_note") if isinstance(parsed, dict) else None
    return DirectAvatarResponse(
        action_timeline=action_timeline,
        director_note=director_note.strip() if isinstance(director_note, str) and director_note.strip() else None,
    )
