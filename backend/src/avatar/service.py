import json
import logging
import re

from fastapi import HTTPException

from src.avatar.schemas import (
    AvatarActionBeat,
    AvatarEditAccessoryOption,
    AvatarEditOp,
    DirectAvatarResponse,
    EditAvatarResponse,
    GazeBeat,
    GestureBeat,
    LockedBeat,
    MoodBeat,
    ResolveAvatarTagResponse,
)
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


def _system_prompt(
    action_ids: list[str],
    gesture_ids: list[str],
    gaze_ids: list[str],
    mood_ids: list[str],
    locked_beats: list[LockedBeat],
    duration_ms: int,
    duration_seconds: float,
) -> str:
    action_list = ", ".join(f'"{action_id}"' for action_id in action_ids)
    gesture_list = ", ".join(f'"{g}"' for g in gesture_ids) or "none available"
    gaze_list = ", ".join(f'"{g}"' for g in gaze_ids) or "none available"
    mood_list = ", ".join(f'"{m}"' for m in mood_ids) or "none available"
    locked_lines = (
        "\n".join(
            f'- {beat.layer} "{beat.beat_id}" already covers {beat.start_ms}-{beat.end_ms}ms -- '
            "never propose an overlapping beat in that SAME layer."
            for beat in locked_beats
        )
        or "(none)"
    )
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
        f'"gesture_timeline": [{{"gesture_id": <one of: {gesture_list}>, "start_ms": <int>, '
        '"end_ms": <int>}, ...] -- OPTIONAL short one-shot arm gestures (a wave, a point, a '
        "shrug, ...) for moments that clearly call for one. Most of the script should have NO "
        "gesture beat at all -- these are occasional emphasis, not constant motion.\n"
        f'"gaze_timeline": [{{"gaze_id": <one of: {gaze_list}>, "start_ms": <int>, "end_ms": '
        "<int>}, ...] -- OPTIONAL head-turn beats for moments the script implies looking "
        "somewhere in particular.\n"
        f'"mood_timeline": [{{"mood_id": <one of: {mood_list}>, "start_ms": <int>, "end_ms": '
        "<int>}, ...] -- OPTIONAL mood/expression beats for stretches with a clear emotional "
        "tone.\n"
        "The gesture/gaze/mood timelines are each INDEPENDENT of action_timeline and of each "
        "other -- beats WITHIN one timeline must not overlap each other, but a gesture/gaze/mood "
        "beat MAY overlap an action_timeline beat (they animate different parts of the body at "
        "once). The following beats are ALREADY LOCKED IN by the creator's own script tags -- "
        f"never propose a new beat that overlaps one of these in the SAME layer:\n{locked_lines}\n"
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


def _parse_layer_timeline(
    raw: object,
    id_field: str,
    allowed_ids: set[str],
    duration_ms: int,
    locked_ranges: list[tuple[int, int]],
) -> list[tuple[str, int, int]]:
    """Shared validate/clamp/drop pass for the gesture/gaze/mood timelines --
    each entry's own id must be in this avatar's closed vocabulary, its
    range gets clamped into [0, duration_ms] same as _parse_action_timeline
    above, then (sorted ascending) any beat overlapping a tag-locked range in
    this SAME layer is dropped outright (never clipped to fit -- a beat that
    would have collided just doesn't get proposed), and any beat overlapping
    an already-accepted one in this same timeline is likewise dropped (greedy
    keep-first, since the system prompt already asked for non-overlapping
    beats within one timeline but an LLM's output is never trusted blindly)."""
    if not isinstance(raw, list):
        return []
    candidates: list[tuple[str, int, int]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        beat_id, start_ms, end_ms = entry.get(id_field), entry.get("start_ms"), entry.get("end_ms")
        if not isinstance(beat_id, str) or beat_id not in allowed_ids:
            continue
        if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
            continue
        clamped_start = max(0, min(int(start_ms), duration_ms))
        clamped_end = max(0, min(int(end_ms), duration_ms))
        if clamped_end <= clamped_start:
            continue
        candidates.append((beat_id, clamped_start, clamped_end))
    candidates.sort(key=lambda candidate: candidate[1])

    accepted: list[tuple[str, int, int]] = []
    for beat_id, start_ms, end_ms in candidates:
        if any(start_ms < locked_end and end_ms > locked_start for locked_start, locked_end in locked_ranges):
            continue
        if accepted and start_ms < accepted[-1][2]:
            continue
        accepted.append((beat_id, start_ms, end_ms))
    return accepted


def _parse_gesture_timeline(raw: object, allowed_ids: set[str], duration_ms: int, locked_ranges: list[tuple[int, int]]) -> list[GestureBeat]:
    return [
        GestureBeat(gesture_id=beat_id, start_ms=start_ms, end_ms=end_ms)
        for beat_id, start_ms, end_ms in _parse_layer_timeline(raw, "gesture_id", allowed_ids, duration_ms, locked_ranges)
    ]


def _parse_gaze_timeline(raw: object, allowed_ids: set[str], duration_ms: int, locked_ranges: list[tuple[int, int]]) -> list[GazeBeat]:
    return [
        GazeBeat(gaze_id=beat_id, start_ms=start_ms, end_ms=end_ms)
        for beat_id, start_ms, end_ms in _parse_layer_timeline(raw, "gaze_id", allowed_ids, duration_ms, locked_ranges)
    ]


def _parse_mood_timeline(raw: object, allowed_ids: set[str], duration_ms: int, locked_ranges: list[tuple[int, int]]) -> list[MoodBeat]:
    return [
        MoodBeat(mood_id=beat_id, start_ms=start_ms, end_ms=end_ms)
        for beat_id, start_ms, end_ms in _parse_layer_timeline(raw, "mood_id", allowed_ids, duration_ms, locked_ranges)
    ]


async def direct_avatar_actions(
    script: str,
    narration_duration_seconds: float,
    action_ids: list[str],
    gesture_ids: list[str],
    gaze_ids: list[str],
    mood_ids: list[str],
    locked_beats: list[LockedBeat],
    user_id: str,
    provider: LLMProvider,
) -> DirectAvatarResponse:
    """Turns a narration script into a timed AvatarAction sequence PLUS
    gesture/gaze/mood timelines -- same calling convention as
    niches/service.py's get_or_create_niche: one provider.complete() call
    against a system prompt enumerating the closed vocabularies + exact JSON
    shape, json.loads wrapped in try/except that logs the raw response on
    failure, then metered as a usage event (abuse-rate-limiting, no billing,
    per project convention). `locked_beats` (tag-derived, already committed
    on the script) are told to the LLM as ranges to steer around AND
    re-enforced defensively by the parser below -- an LLM response is
    untrusted input, not just a convenience."""
    duration_ms = max(1, round(narration_duration_seconds * 1000))
    allowed_action_ids = set(action_ids) if action_ids else set(_BASELINE_ACTION_IDS)
    allowed_gesture_ids = set(gesture_ids)
    allowed_gaze_ids = set(gaze_ids)
    allowed_mood_ids = set(mood_ids)
    locked_ranges_by_layer: dict[str, list[tuple[int, int]]] = {"gesture": [], "gaze": [], "mood": []}
    for beat in locked_beats:
        if beat.layer in locked_ranges_by_layer:
            locked_ranges_by_layer[beat.layer].append((beat.start_ms, beat.end_ms))

    response: str | None = None
    try:
        completion = await provider.complete(
            f"Script:\n{script.strip()}",
            system=_system_prompt(
                sorted(allowed_action_ids), gesture_ids, gaze_ids, mood_ids, locked_beats, duration_ms, narration_duration_seconds
            ),
            max_tokens=1600,
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

    gesture_timeline = _parse_gesture_timeline(
        parsed.get("gesture_timeline") if isinstance(parsed, dict) else None,
        allowed_gesture_ids,
        duration_ms,
        locked_ranges_by_layer["gesture"],
    )
    gaze_timeline = _parse_gaze_timeline(
        parsed.get("gaze_timeline") if isinstance(parsed, dict) else None, allowed_gaze_ids, duration_ms, locked_ranges_by_layer["gaze"]
    )
    mood_timeline = _parse_mood_timeline(
        parsed.get("mood_timeline") if isinstance(parsed, dict) else None, allowed_mood_ids, duration_ms, locked_ranges_by_layer["mood"]
    )

    director_note = parsed.get("director_note") if isinstance(parsed, dict) else None
    return DirectAvatarResponse(
        action_timeline=action_timeline,
        gesture_timeline=gesture_timeline,
        gaze_timeline=gaze_timeline,
        mood_timeline=mood_timeline,
        director_note=director_note.strip() if isinstance(director_note, str) and director_note.strip() else None,
    )


def _resolve_tag_system_prompt(gesture_ids: list[str], gaze_ids: list[str], mood_ids: list[str]) -> str:
    return (
        "A creator typed a short word or phrase as a script tag for a 2D cartoon avatar, meant to pick "
        "one of a fixed set of gesture/gaze/mood ids, but it didn't match any of them exactly. Map it to "
        "the SINGLE closest id, or say none are close enough. Respond with ONLY a JSON object: "
        '{"layer": <"gesture"|"gaze"|"mood"|null>, "id": <string|null>} -- both null together means no '
        "good match.\n"
        f'Gesture ids: {", ".join(gesture_ids) or "none available"}\n'
        f'Gaze ids: {", ".join(gaze_ids) or "none available"}\n'
        f'Mood ids: {", ".join(mood_ids) or "none available"}\n'
        "Only use ids from these lists -- never invent one. No markdown fences, no commentary."
    )


async def resolve_avatar_tag(
    free_text: str,
    gesture_ids: list[str],
    gaze_ids: list[str],
    mood_ids: list[str],
    user_id: str,
    provider: LLMProvider,
) -> ResolveAvatarTagResponse:
    """Maps an unrecognized `{freeword}` script tag (avatar/tags.ts) to the
    closest known gesture/gaze/mood id -- same calling convention as
    edit_avatar_design: one provider.complete() call against a closed-
    vocabulary system prompt, json.loads in try/except, the returned id
    re-validated against the matching list before ever being trusted, metered
    as a usage event."""
    response: str | None = None
    try:
        completion = await provider.complete(
            free_text.strip(),
            system=_resolve_tag_system_prompt(gesture_ids, gaze_ids, mood_ids),
            max_tokens=100,
        )
        response = completion.text
        parsed = json.loads(response)
    except Exception as exc:
        logger.exception("avatar tag resolution failed; raw response: %r", response)
        raise HTTPException(status_code=502, detail="Couldn't resolve that tag -- try again") from exc

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
            metadata={"feature": "avatar_tag_resolve"},
        )

    layer = parsed.get("layer") if isinstance(parsed, dict) else None
    tag_id = parsed.get("id") if isinstance(parsed, dict) else None
    allowed_by_layer = {"gesture": set(gesture_ids), "gaze": set(gaze_ids), "mood": set(mood_ids)}
    if layer not in allowed_by_layer or not isinstance(tag_id, str) or tag_id not in allowed_by_layer[layer]:
        return ResolveAvatarTagResponse(layer=None, id=None)
    return ResolveAvatarTagResponse(layer=layer, id=tag_id)


# Phase 7 -- conversational Design edits. Independent bound on "how much
# bigger/smaller" a setBoneScale op may push one bone group -- same range
# frontend/src/lib/video/avatar/edits.ts's own MIN/MAX_BONE_SCALE clamps to
# (that file re-validates/re-clamps everything this endpoint returns anyway,
# so the two ranges matching is a nicety, not a security boundary).
_MIN_BONE_SCALE = 0.4
_MAX_BONE_SCALE = 2.2
_HEX_COLOR_RE = re.compile(r"^#([0-9a-f]{3}|[0-9a-f]{6})$", re.IGNORECASE)
_KNOWN_EDIT_OPS = {
    "setBoneScale",
    "setColorSlot",
    "addAccessory",
    "removeAccessory",
    "setExpression",
    "setGarment",
    "setAction",
    "setFraming",
}
_FRAMING_IDS = {"full", "bust"}


def _edit_system_prompt(
    bone_group_ids: list[str],
    color_slot_ids: list[str],
    accessories: list[AvatarEditAccessoryOption],
    expression_params: dict[str, list[float]],
    action_ids: list[str],
    garment_ids: list[str],
) -> str:
    accessory_lines = ", ".join(f'"{a.accessory_asset_id}" (anchor "{a.anchor_id}")' for a in accessories) or "none available"
    expression_lines = (
        ", ".join(f'"{param_id}" (range {bounds[0]} to {bounds[1]})' for param_id, bounds in expression_params.items())
        or "none available"
    )
    return (
        "You translate a creator's free-text request into edits on a simple "
        "2D cartoon avatar. Respond with ONLY a JSON object: "
        '{"ops": [...]} -- a list of 0 or more primitive ops, each one of:\n'
        f'{{"op": "setBoneScale", "group_id": <one of: {", ".join(bone_group_ids) or "none available"}>, '
        f'"value": <float {_MIN_BONE_SCALE}-{_MAX_BONE_SCALE}, 1.0 = no change, smaller = thinner/shorter, '
        'bigger = fatter/taller>} -- for a concrete size/proportion request ("make it fatter", "bigger arms").\n'
        f'{{"op": "setColorSlot", "slot_id": <one of: {", ".join(color_slot_ids) or "none available"}>, '
        '"color": <"#rrggbb" hex>} -- for a concrete recolor request ("red shirt", "black pants").\n'
        f'{{"op": "addAccessory", "anchor_id": <the accessory\'s own paired anchor>, '
        f'"accessory_asset_id": <one of: {accessory_lines}>}} -- for a concrete "add X" request.\n'
        '{"op": "removeAccessory", "anchor_id": <an anchor a currently-worn accessory occupies>} -- for a concrete "remove X" request.\n'
        f'{{"op": "setExpression", "param_id": <one of: {expression_lines}>, "value": <float within that '
        'param\'s own range>} -- for a DESCRIPTIVE mood/personality request that has no single concrete knob '
        '("more evil", "friendlier", "tired", "energetic"): push the closest-matching param(s) toward whichever '
        "end of their own range reads as that mood, and optionally also nudge a clothing color slot toward a "
        "darker/cooler shade for a harsher mood or a warmer shade for a friendlier one.\n"
        f'{{"op": "setGarment", "garment_id": <one of: {", ".join(garment_ids) or "none available"}>}} -- for an '
        'outfit/clothing-style request ("put him in a suit", "just a plain shirt"); "shirt" means the plain base '
        "torso with no outfit shape.\n"
        f'{{"op": "setAction", "action_id": <one of: {", ".join(action_ids) or "none available"}>}} -- for a request '
        'about what the avatar is DOING right now ("have her sit down", "make him walk").\n'
        '{"op": "setFraming", "framing": <"full" or "bust">} -- for a shot-framing request ("close-up on his face", '
        '"portrait shot", "show his whole body"); "bust" crops to hands+torso+head, "full" shows the whole rig.\n'
        "Only use ids from the lists above -- never invent one. If the request doesn't correspond to anything "
        "achievable with these ops, return an empty ops list rather than guessing. No markdown fences, no commentary."
    )


def _parse_edit_ops(
    raw: object,
    bone_group_ids: set[str],
    color_slot_ids: set[str],
    accessories_by_id: dict[str, AvatarEditAccessoryOption],
    expression_params: dict[str, list[float]],
    action_ids: set[str],
    garment_ids: set[str],
) -> list[AvatarEditOp]:
    if not isinstance(raw, list):
        return []
    ops: list[AvatarEditOp] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        op = entry.get("op")
        if op not in _KNOWN_EDIT_OPS:
            continue

        if op == "setBoneScale":
            group_id, value = entry.get("group_id"), entry.get("value")
            if group_id not in bone_group_ids or not isinstance(value, (int, float)):
                continue
            ops.append(AvatarEditOp(op=op, group_id=group_id, value=max(_MIN_BONE_SCALE, min(float(value), _MAX_BONE_SCALE))))

        elif op == "setColorSlot":
            slot_id, color = entry.get("slot_id"), entry.get("color")
            if slot_id not in color_slot_ids or not isinstance(color, str) or not _HEX_COLOR_RE.match(color):
                continue
            ops.append(AvatarEditOp(op=op, slot_id=slot_id, color=color))

        elif op == "addAccessory":
            accessory_asset_id, anchor_id = entry.get("accessory_asset_id"), entry.get("anchor_id")
            accessory = accessories_by_id.get(accessory_asset_id) if isinstance(accessory_asset_id, str) else None
            if accessory is None or accessory.anchor_id != anchor_id:
                continue
            color_override = entry.get("color_override")
            ops.append(
                AvatarEditOp(
                    op=op,
                    anchor_id=anchor_id,
                    accessory_asset_id=accessory_asset_id,
                    color_override=color_override if isinstance(color_override, str) and _HEX_COLOR_RE.match(color_override) else None,
                )
            )

        elif op == "removeAccessory":
            anchor_id = entry.get("anchor_id")
            if not isinstance(anchor_id, str) or not anchor_id:
                continue
            ops.append(AvatarEditOp(op=op, anchor_id=anchor_id))

        elif op == "setExpression":
            param_id, value = entry.get("param_id"), entry.get("value")
            bounds = expression_params.get(param_id) if isinstance(param_id, str) else None
            if bounds is None or not isinstance(value, (int, float)):
                continue
            low, high = min(bounds), max(bounds)
            ops.append(AvatarEditOp(op=op, param_id=param_id, value=max(low, min(float(value), high))))

        elif op == "setGarment":
            garment_id = entry.get("garment_id")
            if garment_id not in garment_ids:
                continue
            ops.append(AvatarEditOp(op=op, garment_id=garment_id))

        elif op == "setAction":
            action_id = entry.get("action_id")
            if action_id not in action_ids:
                continue
            ops.append(AvatarEditOp(op=op, action_id=action_id))

        elif op == "setFraming":
            framing = entry.get("framing")
            if framing not in _FRAMING_IDS:
                continue
            ops.append(AvatarEditOp(op=op, framing=framing))

    return ops


async def edit_avatar_design(
    prompt: str,
    bone_group_ids: list[str],
    color_slot_ids: list[str],
    accessories: list[AvatarEditAccessoryOption],
    expression_params: dict[str, list[float]],
    action_ids: list[str],
    garment_ids: list[str],
    user_id: str,
    provider: LLMProvider,
) -> EditAvatarResponse:
    """Turns a free-text prompt ("make it fatter", "add sunglasses", "make
    him look more evil") into a batch of primitive edit ops -- same calling
    convention as niches/service.py's get_or_create_niche and this module's
    own direct_avatar_actions above: one provider.complete() call against a
    system prompt enumerating the closed op vocabulary + this SPECIFIC
    avatar's own resolved ids, json.loads wrapped in try/except that logs the
    raw response on failure, then metered as a usage event. Every op is
    validated against the caller-supplied ids and clamped/dropped exactly
    like _parse_action_timeline already does for direct_avatar_actions -- an
    LLM response is untrusted input, not just a convenience, and this
    endpoint's whole job is translating fuzzy language into an
    already-bounded parameter space, never open-ended generation."""
    accessories_by_id = {a.accessory_asset_id: a for a in accessories}

    response: str | None = None
    try:
        completion = await provider.complete(
            prompt.strip(),
            system=_edit_system_prompt(bone_group_ids, color_slot_ids, accessories, expression_params, action_ids, garment_ids),
            max_tokens=600,
        )
        response = completion.text
        parsed = json.loads(response)
    except Exception as exc:
        logger.exception("avatar edit failed; raw response: %r", response)
        raise HTTPException(status_code=502, detail="Couldn't apply that edit -- try again") from exc

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
            metadata={"feature": "avatar_edit"},
        )

    ops = _parse_edit_ops(
        parsed.get("ops") if isinstance(parsed, dict) else None,
        set(bone_group_ids),
        set(color_slot_ids),
        accessories_by_id,
        expression_params,
        set(action_ids),
        set(garment_ids),
    )
    # An empty (but well-formed) ops list is a legitimate response -- the
    # prompt may genuinely not correspond to anything achievable, and the
    # system prompt explicitly tells the model to say so rather than guess --
    # only a JSON/shape failure above is treated as an error.
    return EditAvatarResponse(ops=ops)
