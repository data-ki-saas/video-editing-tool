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
    source_cartoon_key: str | None = None


def create(
    *, id: str, user_id: str, name: str, skin: dict, design: dict, atlas_key: str, source_cartoon_key: str | None = None
) -> AvatarDesignRecord:
    payload = {
        "id": id,
        "user_id": user_id,
        "name": name,
        "skin": skin,
        "design": design,
        "atlas_key": atlas_key,
        "source_cartoon_key": source_cartoon_key,
    }
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


def update_baked(design_id: str, user_id: str, skin: dict, design: dict) -> AvatarDesignRecord | None:
    """Rebake path (service.py's rebake_generated_avatar / _rebake_record):
    overwrites the stored Skin/Design's baked fields (atlas.partRects, parts'
    mouth pivot, and every other baked-in-code schema field --
    mouthShapes/colorSlots/garmentShapes/expressionShapes) in place after
    re-running build_atlas_png_from_photo against the cached
    source_cartoon_key. `atlas_key` itself never changes here -- the PNG at
    that key was overwritten, not replaced, so no other row/reference needs
    updating."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .update({"skin": skin, "design": design})
        .eq("id", design_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        return None
    return AvatarDesignRecord(**result.data[0])


def list_with_source_cartoon() -> list[AvatarDesignRecord]:
    """Every avatar (across all users) that has a cached fal.ai cartoonify
    output and can therefore be rebaked without re-calling fal.ai -- used by
    scripts/rebake_avatars.py to roll an atlas_builder.py fix out to existing
    avatars in bulk. Runs under the backend's service-role Supabase client,
    which bypasses this table's per-user RLS policy."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*")
        .not_.is_("source_cartoon_key", "null")
        .execute()
    )
    return [AvatarDesignRecord(**row) for row in result.data]


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
