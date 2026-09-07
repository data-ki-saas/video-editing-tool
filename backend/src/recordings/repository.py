from dataclasses import dataclass

from src.core.supabase_client import get_supabase_client

_TABLE = "recordings"


@dataclass
class RecordingRecord:
    id: str
    user_id: str
    name: str
    description: str | None
    kind: str
    mime_type: str
    size_bytes: int
    storage_key: str
    duration_seconds: float | None
    created_at: str
    updated_at: str


def create(
    *,
    user_id: str,
    name: str,
    description: str | None,
    kind: str,
    mime_type: str,
    size_bytes: int,
    storage_key: str,
    duration_seconds: float | None,
) -> RecordingRecord:
    payload = {
        "user_id": user_id,
        "name": name,
        "description": description,
        "kind": kind,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "storage_key": storage_key,
        "duration_seconds": duration_seconds,
    }
    result = get_supabase_client().table(_TABLE).insert(payload).execute()
    return RecordingRecord(**result.data[0])


def list_for_user(user_id: str) -> list[RecordingRecord]:
    """Newest first -- recordings_user_time_idx (0026) makes this a straight
    index scan, not a sort."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [RecordingRecord(**row) for row in result.data or []]


def get_owned(recording_id: str, user_id: str) -> RecordingRecord | None:
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*")
        .eq("id", recording_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return RecordingRecord(**result.data[0])


def update_metadata(recording_id: str, user_id: str, name: str, description: str | None) -> RecordingRecord | None:
    """Owner-scoped update-returns-None-if-unmatched, same convention as
    library/repository.py's update_metadata."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .update({"name": name, "description": description})
        .eq("id", recording_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        return None
    return RecordingRecord(**result.data[0])


def replace_content(
    recording_id: str,
    user_id: str,
    *,
    mime_type: str,
    size_bytes: int,
    storage_key: str,
    duration_seconds: float | None,
) -> RecordingRecord | None:
    """Backs the trim/crop popup's Save -- overwrites the underlying media
    (new storage_key) while keeping the row's id/name/description. Returns
    None (same convention as update_metadata above) if recording_id/user_id
    don't match, so the caller can decide whether to clean up the
    just-uploaded R2 object."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .update(
            {
                "mime_type": mime_type,
                "size_bytes": size_bytes,
                "storage_key": storage_key,
                "duration_seconds": duration_seconds,
            }
        )
        .eq("id", recording_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        return None
    return RecordingRecord(**result.data[0])


def delete(recording_id: str, user_id: str) -> RecordingRecord | None:
    """Owner-scoped delete, returning the deleted row (so the caller can
    read storage_key off it to clean up R2) or None if it didn't match --
    same convention as library/repository.py's delete."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .delete()
        .eq("id", recording_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        return None
    return RecordingRecord(**result.data[0])
