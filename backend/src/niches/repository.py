import re
import uuid
from dataclasses import dataclass

from src.core.supabase_client import get_supabase_client

_TABLE = "niche_configs"


def normalize_niche_key(name: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return key or "general"


@dataclass
class NicheConfigRecord:
    id: str
    niche_key: str
    display_name: str
    fields: list[dict]
    script_template: str | None
    created_at: str
    media_slots: list[dict]
    hooks: list[str]
    cta_template: str | None
    hashtag_seed: list[str]
    language: str


def _strip_internal(row: dict) -> dict:
    return {k: v for k, v in row.items() if k != "created_by"}


def get_niche_by_key(niche_key: str, language: str) -> NicheConfigRecord | None:
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*")
        .eq("niche_key", niche_key)
        .eq("language", language)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return NicheConfigRecord(**_strip_internal(result.data[0]))


def create_niche(
    *,
    niche_key: str,
    display_name: str,
    fields: list[dict],
    script_template: str | None,
    created_by: str,
    media_slots: list[dict],
    hooks: list[str],
    cta_template: str | None,
    hashtag_seed: list[str],
    language: str,
) -> NicheConfigRecord:
    payload = {
        "id": str(uuid.uuid4()),
        "niche_key": niche_key,
        "display_name": display_name,
        "fields": fields,
        "script_template": script_template,
        "created_by": created_by,
        "media_slots": media_slots,
        "hooks": hooks,
        "cta_template": cta_template,
        "hashtag_seed": hashtag_seed,
        "language": language,
    }
    result = get_supabase_client().table(_TABLE).insert(payload).execute()
    return NicheConfigRecord(**_strip_internal(result.data[0]))


def list_niches(language: str | None = None) -> list[NicheConfigRecord]:
    query = get_supabase_client().table(_TABLE).select("*")
    if language is not None:
        query = query.eq("language", language)
    result = query.order("display_name").execute()
    return [NicheConfigRecord(**_strip_internal(row)) for row in result.data]
