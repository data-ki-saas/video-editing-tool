import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

_TABLE = "avatar_designs"
_USAGE_TABLE = "usage_events"
_USAGE_EVENT_TYPE = "avatar_generate"


@dataclass
class AvatarDesignRecord:
    id: str
    user_id: str
    name: str
    skin: dict
    design: dict
    atlas_key: str
    created_at: str


def create(*, id: str, user_id: str, name: str, skin: dict, design: dict, atlas_key: str) -> AvatarDesignRecord:
    payload = {"id": id, "user_id": user_id, "name": name, "skin": skin, "design": design, "atlas_key": atlas_key}
    result = get_supabase_client().table(_TABLE).insert(payload).execute()
    return AvatarDesignRecord(**result.data[0])


def list_for_user(user_id: str) -> list[AvatarDesignRecord]:
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [AvatarDesignRecord(**row) for row in result.data]


def get(design_id: str, user_id: str) -> AvatarDesignRecord | None:
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*")
        .eq("id", design_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return AvatarDesignRecord(**result.data[0])


def rename(design_id: str, user_id: str, name: str, design: dict) -> AvatarDesignRecord | None:
    """Updates the row's own `name` column AND the mirrored `design.meta.name`
    together, in one UPDATE, so a rename can never leave the two fields
    disagreeing partway through -- the caller (service.py's
    rename_generated_avatar) is expected to have already patched `design`
    with the same `name`."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .update({"name": name, "design": design})
        .eq("id", design_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        return None
    return AvatarDesignRecord(**result.data[0])


def delete(design_id: str, user_id: str) -> AvatarDesignRecord | None:
    result = get_supabase_client().table(_TABLE).delete().eq("id", design_id).eq("user_id", user_id).execute()
    if not result.data:
        return None
    return AvatarDesignRecord(**result.data[0])


def count_recent_generate_events(user_id: str) -> int | None:
    """Same fail-OPEN-on-read-error reasoning as matting/repository.py's
    count_recent_matting_events -- a usage_events hiccup shouldn't block the
    feature entirely."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    try:
        result = (
            get_supabase_client()
            .table(_USAGE_TABLE)
            .select("id", count="exact")
            .eq("user_id", user_id)
            .eq("event_type", _USAGE_EVENT_TYPE)
            .gte("created_at", since)
            .execute()
        )
    except Exception:
        logger.exception("failed to check avatar-generate rate limit for user=%s", user_id)
        return None
    return result.count or 0


def record_generate_event(user_id: str) -> None:
    try:
        get_supabase_client().table(_USAGE_TABLE).insert({"user_id": user_id, "event_type": _USAGE_EVENT_TYPE}).execute()
    except Exception:
        logger.exception("failed to record avatar-generate usage event for user=%s", user_id)
