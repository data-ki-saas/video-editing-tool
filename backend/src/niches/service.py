import json
import logging

from fastapi import HTTPException

from src.core.config import settings
from src.llm.providers.base import LLMProvider
from src.metering import pricing as metering_pricing
from src.metering import repository as metering_repository
from src.niches import repository
from src.niches.repository import normalize_niche_key
from src.niches.schemas import MediaSlot, NicheConfig, NicheField

logger = logging.getLogger(__name__)

_VALID_FIELD_TYPES = {"text", "number", "textarea"}
_VALID_SLOT_KINDS = {"image", "video", "either"}

# Used whenever the LLM omits media_slots or returns something unusable --
# every niche still needs a usable wizard media step, so this generic 4-slot
# shape (hook shot / primary view / detail shot / standout extra) is a
# reasonable niche-agnostic fallback rather than failing the whole
# generation over one optional section.
_FALLBACK_MEDIA_SLOTS: list[dict] = [
    {"key": "hero", "label": "Hero Shot", "hint": "Your best, most eye-catching shot", "kind": "either", "required": True},
    {"key": "primary_view", "label": "Primary View", "hint": "The main space or item, straight-on", "kind": "either", "required": True},
    {"key": "detail_shot", "label": "Detail Shot", "hint": "A close-up on what makes this special", "kind": "either", "required": False},
    {"key": "standout_extra", "label": "Standout Extra", "hint": "Anything else worth showing off", "kind": "either", "required": False},
]

SYSTEM_PROMPT = (
    "You help design a guided creation wizard for a business making a short "
    "promotional video reel for one of their listings/items/services. Given "
    "a business niche, respond with ONLY a JSON object with these keys:\n"
    '"display_name": <Title Case niche name>.\n'
    '"fields": [{"key": <snake_case>, "label": <Human label>, '
    '"type": "text|number|textarea", "required": <true|false>}, ...] -- '
    "3-6 fields covering what actually matters for that niche (e.g. for a "
    "car dealership: make, model, year, mileage, price -- for a hotel: "
    'room_type, nightly_rate, amenities). Always include a "price" field '
    "unless the niche has no obvious price.\n"
    '"script_template": <a short (2-3 sentence) voiceover script with '
    "{field_key} placeholders for each field above>.\n"
    '"media_slots": [{"key": <snake_case>, "label": <Human label>, '
    '"hint": <what to actually photograph/film for this slot, one short '
    'phrase>, "kind": "image|video|either", "required": <true|false>}, ...] '
    "-- 4-6 ordered upload slots telling the user exactly what to capture, "
    "as a hook -> tour -> standout-feature story for that niche (e.g. real "
    "estate: hero exterior/street shot, primary living area, private space "
    "like a bedroom, standout amenity; a hotel: facade, room, amenity/pool, "
    "lobby; a car dealership: exterior 3/4 view, interior/dash, engine bay, "
    "feature close-up).\n"
    '"hooks": [<3-5 short, high-performing opening lines to overlay on the '
    "first 2 seconds of the reel, each with {field_key} placeholders where "
    'natural, e.g. "Would you live here for {price}/month?">].\n'
    '"cta_template": <one short end-screen call-to-action line with a '
    "{keyword} placeholder the user fills in, e.g. \"Comment '{keyword}' "
    'below for the full details!">.\n'
    '"hashtag_seed": [<3-6 short generic hashtag stems for this niche, no '
    '"#", e.g. ["RealEstate","HomesForSale"]>].\n'
    "No markdown fences, no commentary."
)

# language code -> (English name, script name), used to steer the LLM's
# spoken/read output into a specific Indian language + script. Adding
# another Indian language later is just one more entry here (plus the
# frontend's mirroring LANGUAGE_SCRIPTS table in lib/transliteration.ts,
# tts/service.py's _SCRIPT_RANGES, and tts/providers/edge_provider.py's
# voice catalog).
_LANGUAGE_INFO: dict[str, tuple[str, str]] = {
    "hi": ("Hindi", "Devanagari"),
    "mr": ("Marathi", "Devanagari"),
    "pa": ("Punjabi", "Gurmukhi"),
    "bn": ("Bengali", "Bengali"),
    "ta": ("Tamil", "Tamil"),
    "or": ("Odia", "Odia"),
}


def _system_prompt(language: str) -> str:
    info = _LANGUAGE_INFO.get(language)
    if info is None:
        return SYSTEM_PROMPT
    name, script = info
    return (
        SYSTEM_PROMPT
        + f"\nWrite script_template, hooks, and cta_template entirely in {name} "
        f"using {script} script -- these are read aloud/shown to a {name}-speaking "
        "viewer. Keep display_name, fields[].label, and media_slots[].label/hint "
        "in English (they're wizard UI chrome, not viewer-facing script)."
    )


def _to_schema(record: repository.NicheConfigRecord) -> NicheConfig:
    return NicheConfig(
        id=record.id,
        niche_key=record.niche_key,
        display_name=record.display_name,
        fields=[NicheField(**field) for field in record.fields],
        script_template=record.script_template,
        media_slots=[MediaSlot(**slot) for slot in record.media_slots],
        hooks=record.hooks,
        cta_template=record.cta_template,
        hashtag_seed=record.hashtag_seed,
        created_at=record.created_at,
        language=record.language,
    )


def _parse_generated_fields(raw_fields: object) -> list[dict]:
    if not isinstance(raw_fields, list):
        return []
    fields = []
    for entry in raw_fields:
        if not isinstance(entry, dict):
            continue
        key, label, field_type = entry.get("key"), entry.get("label"), entry.get("type")
        if not isinstance(key, str) or not isinstance(label, str) or field_type not in _VALID_FIELD_TYPES:
            continue
        fields.append({"key": key, "label": label, "type": field_type, "required": bool(entry.get("required", False))})
    return fields


def _parse_media_slots(raw_slots: object) -> list[dict]:
    if not isinstance(raw_slots, list):
        return []
    slots = []
    for entry in raw_slots:
        if not isinstance(entry, dict):
            continue
        key, label, hint = entry.get("key"), entry.get("label"), entry.get("hint")
        kind = entry.get("kind", "either")
        if not isinstance(key, str) or not isinstance(label, str) or not isinstance(hint, str) or kind not in _VALID_SLOT_KINDS:
            continue
        slots.append({"key": key, "label": label, "hint": hint, "kind": kind, "required": bool(entry.get("required", False))})
    return slots


def _parse_string_list(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [entry.strip() for entry in raw if isinstance(entry, str) and entry.strip()]


async def get_or_create_niche(name: str, user_id: str, provider: LLMProvider, language: str = "en") -> NicheConfig:
    """Looks up a cached niche config by its normalized key + language, or
    asks the configured LLM provider to design one (fields + a voiceover
    script template, in the requested language) and persists it for every
    future caller asking for that same niche+language. The generated schema
    is a UI scaffold, not an enforced one -- a project's `attributes` stays
    a freeform jsonb column regardless of what fields were suggested here."""
    niche_key = normalize_niche_key(name)

    existing = repository.get_niche_by_key(niche_key, language)
    if existing is not None:
        return _to_schema(existing)

    response: str | None = None
    try:
        # 800 was enough back when this only asked for fields+script_template;
        # media_slots/hooks/cta_template/hashtag_seed made the expected JSON
        # much larger (a rich niche like real estate easily wants 6 detailed
        # media slots + 5 hooks), and a response cut off mid-JSON fails
        # json.loads() below just like a real generation error would -- kept
        # generous rather than tuned tight, since a bigger cap costs nothing
        # when the model naturally stops earlier for a simpler niche.
        completion = await provider.complete(
            f"Business niche: {name.strip()}", system=_system_prompt(language), max_tokens=1800
        )
        response = completion.text
        parsed = json.loads(response)
    except Exception as exc:
        # Include the raw response on a JSON-parse failure specifically --
        # "invalid JSON" alone doesn't say whether it was truncated,
        # malformed, or wrapped in markdown fences despite the prompt saying
        # not to, and this is the one thing that actually shows which.
        logger.exception("niche generation failed for %r; raw response: %r", name, response)
        raise HTTPException(status_code=502, detail="Couldn't generate a form for that niche -- try again") from exc

    # No completion means no billable tokens either way, per each provider's
    # own billing model -- only log on the success path above.
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
            metadata={"niche_name": name},
        )

    display_name = parsed.get("display_name") if isinstance(parsed, dict) else None
    fields = _parse_generated_fields(parsed.get("fields") if isinstance(parsed, dict) else None)
    script_template = parsed.get("script_template") if isinstance(parsed, dict) else None
    cta_template = parsed.get("cta_template") if isinstance(parsed, dict) else None

    if not isinstance(display_name, str) or not fields:
        logger.error("niche generation returned an invalid shape for %r: %r", name, parsed)
        raise HTTPException(status_code=502, detail="Couldn't generate a form for that niche -- try again")

    # media_slots/hooks/cta_template/hashtag_seed are wizard scaffolding, not
    # load-bearing -- an LLM omission there shouldn't fail the whole niche,
    # unlike display_name/fields above. media_slots gets a generic fallback
    # so the wizard's media step always has something to show.
    media_slots = _parse_media_slots(parsed.get("media_slots") if isinstance(parsed, dict) else None) or _FALLBACK_MEDIA_SLOTS
    hooks = _parse_string_list(parsed.get("hooks") if isinstance(parsed, dict) else None)
    hashtag_seed = _parse_string_list(parsed.get("hashtag_seed") if isinstance(parsed, dict) else None)

    try:
        record = repository.create_niche(
            niche_key=niche_key,
            display_name=display_name,
            fields=fields,
            script_template=script_template if isinstance(script_template, str) else None,
            created_by=user_id,
            media_slots=media_slots,
            hooks=hooks,
            cta_template=cta_template if isinstance(cta_template, str) else None,
            hashtag_seed=hashtag_seed,
            language=language,
        )
    except Exception:
        # Another request may have created the same niche_key+language
        # concurrently (unique constraint) -- fall back to whatever's there
        # now rather than erroring on a benign race.
        existing = repository.get_niche_by_key(niche_key, language)
        if existing is None:
            raise
        record = existing

    return _to_schema(record)


def list_niches(language: str | None = None) -> list[NicheConfig]:
    return [_to_schema(record) for record in repository.list_niches(language)]
