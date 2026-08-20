import json
import logging

from fastapi import HTTPException

from src.llm.providers.base import LLMProvider
from src.niches import repository
from src.niches.repository import normalize_niche_key
from src.niches.schemas import NicheConfig, NicheField

logger = logging.getLogger(__name__)

_VALID_FIELD_TYPES = {"text", "number", "textarea"}

SYSTEM_PROMPT = (
    "You help design a short intake form and a voiceover script template for "
    "a business creating a short promotional video reel for one of their "
    "listings/items/services. Given a business niche, respond with ONLY a "
    'JSON object: {"display_name": "<Title Case niche name>", '
    '"fields": [{"key": "<snake_case>", "label": "<Human label>", '
    '"type": "text|number|textarea", "required": <true|false>}, ...], '
    '"script_template": "<a short (2-3 sentence) voiceover script with '
    '{field_key} placeholders for each field above>"}. '
    "Include 3-6 fields covering what actually matters for that niche (e.g. "
    "for a car dealership: make, model, year, mileage, price -- for a hotel: "
    'room_type, nightly_rate, amenities). Always include a "price" field '
    "unless the niche has no obvious price (e.g. purely informational). No "
    "markdown fences, no commentary."
)


def _to_schema(record: repository.NicheConfigRecord) -> NicheConfig:
    return NicheConfig(
        id=record.id,
        niche_key=record.niche_key,
        display_name=record.display_name,
        fields=[NicheField(**field) for field in record.fields],
        script_template=record.script_template,
        created_at=record.created_at,
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


async def get_or_create_niche(name: str, user_id: str, provider: LLMProvider) -> NicheConfig:
    """Looks up a cached niche config by its normalized key, or asks the
    configured LLM provider to design one (fields + a voiceover script
    template) and persists it for every future caller. The generated schema
    is a UI scaffold, not an enforced one -- a project's `attributes` stays
    a freeform jsonb column regardless of what fields were suggested here."""
    niche_key = normalize_niche_key(name)

    existing = repository.get_niche_by_key(niche_key)
    if existing is not None:
        return _to_schema(existing)

    try:
        response = await provider.complete(f"Business niche: {name.strip()}", system=SYSTEM_PROMPT, max_tokens=800)
        parsed = json.loads(response)
    except Exception as exc:
        logger.exception("niche generation failed for %r", name)
        raise HTTPException(status_code=502, detail="Couldn't generate a form for that niche -- try again") from exc

    display_name = parsed.get("display_name") if isinstance(parsed, dict) else None
    fields = _parse_generated_fields(parsed.get("fields") if isinstance(parsed, dict) else None)
    script_template = parsed.get("script_template") if isinstance(parsed, dict) else None

    if not isinstance(display_name, str) or not fields:
        logger.error("niche generation returned an invalid shape for %r: %r", name, parsed)
        raise HTTPException(status_code=502, detail="Couldn't generate a form for that niche -- try again")

    try:
        record = repository.create_niche(
            niche_key=niche_key,
            display_name=display_name,
            fields=fields,
            script_template=script_template if isinstance(script_template, str) else None,
            created_by=user_id,
        )
    except Exception:
        # Another request may have created the same niche_key concurrently
        # (unique constraint) -- fall back to whatever's there now rather
        # than erroring on a benign race.
        existing = repository.get_niche_by_key(niche_key)
        if existing is None:
            raise
        record = existing

    return _to_schema(record)


def list_niches() -> list[NicheConfig]:
    return [_to_schema(record) for record in repository.list_niches()]
