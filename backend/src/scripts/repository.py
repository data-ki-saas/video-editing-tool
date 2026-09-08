from dataclasses import dataclass

from src.core.supabase_client import get_supabase_client

_TABLE = "scripts"


@dataclass
class ScriptRecord:
    id: str
    user_id: str
    name: str
    text: str
    created_at: str
    updated_at: str


def create(*, user_id: str, name: str, text: str) -> ScriptRecord:
    payload = {"user_id": user_id, "name": name, "text": text}
    result = get_supabase_client().table(_TABLE).insert(payload).execute()
    return ScriptRecord(**result.data[0])


def list_for_user(user_id: str) -> list[ScriptRecord]:
    """Newest first -- scripts_user_time_idx (0028) makes this a straight
    index scan, not a sort."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [ScriptRecord(**row) for row in result.data or []]


def count_for_user(user_id: str) -> int:
    """Total LIVE row count for this user -- backs scripts/service.py's
    MAX_SCRIPTS_PER_USER cap, same convention as recordings/repository.py's
    own count_for_user."""
    result = get_supabase_client().table(_TABLE).select("id", count="exact").eq("user_id", user_id).execute()
    return result.count or 0


def delete(script_id: str, user_id: str) -> ScriptRecord | None:
    """Owner-scoped delete, returning the deleted row or None if it didn't
    match -- same convention as recordings/repository.py's delete."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .delete()
        .eq("id", script_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        return None
    return ScriptRecord(**result.data[0])
