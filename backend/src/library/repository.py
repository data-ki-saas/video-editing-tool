from dataclasses import dataclass

from src.core.supabase_client import get_supabase_client

_TABLE = "library_videos"


@dataclass
class LibraryVideoRecord:
    id: str
    user_id: str
    project_id: str | None
    project_name: str
    description: str | None
    video_url: str
    thumbnail_url: str | None
    duration_seconds: float | None
    is_template: bool
    created_at: str


def create(
    *,
    user_id: str,
    project_id: str,
    project_name: str,
    video_url: str,
    thumbnail_url: str | None,
    duration_seconds: float | None,
) -> LibraryVideoRecord:
    payload = {
        "user_id": user_id,
        "project_id": project_id,
        "project_name": project_name,
        "video_url": video_url,
        "thumbnail_url": thumbnail_url,
        "duration_seconds": duration_seconds,
    }
    result = get_supabase_client().table(_TABLE).insert(payload).execute()
    return LibraryVideoRecord(**result.data[0])


def list_for_user(user_id: str) -> list[LibraryVideoRecord]:
    """Newest first -- library_videos_user_time_idx (0023) makes this a
    straight index scan, not a sort."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [LibraryVideoRecord(**row) for row in result.data or []]


def get_by_id(video_id: str) -> LibraryVideoRecord | None:
    """Unscoped by user_id -- only used by the public share view
    (GET /api/library/public/{id}), where the video's own hard-to-guess
    UUID is the only credential a share link carries, same trust model as
    the video_url/thumbnail_url R2 objects themselves (public bucket, no
    auth check on the object itself either)."""
    result = get_supabase_client().table(_TABLE).select("*").eq("id", video_id).limit(1).execute()
    if not result.data:
        return None
    return LibraryVideoRecord(**result.data[0])


def get_owned(video_id: str, user_id: str) -> LibraryVideoRecord | None:
    """Owner-scoped lookup, unlike get_by_id above (which backs the public
    share view and is deliberately unscoped) -- for a caller that needs to
    both find AND authorize a specific video in one step, e.g.
    social/service.py's publish, which needs this row's video_url as the
    upload source and must not let one user post another's saved reel."""
    result = get_supabase_client().table(_TABLE).select("*").eq("id", video_id).eq("user_id", user_id).limit(1).execute()
    if not result.data:
        return None
    return LibraryVideoRecord(**result.data[0])


def set_is_template(video_id: str, user_id: str, is_template: bool) -> LibraryVideoRecord | None:
    """Scoped by user_id directly (not a separate ownership check first) --
    an update matching zero rows (wrong id, or someone else's video) just
    returns None, same 404-if-None convention as every other owner-scoped
    mutation in this backend."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .update({"is_template": is_template})
        .eq("id", video_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        return None
    return LibraryVideoRecord(**result.data[0])


def update_metadata(video_id: str, user_id: str, project_name: str, description: str | None) -> LibraryVideoRecord | None:
    """Backs the library page's in-place name/description editing. Same
    owner-scoped update-returns-None-if-unmatched convention as
    set_is_template above."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .update({"project_name": project_name, "description": description})
        .eq("id", video_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        return None
    return LibraryVideoRecord(**result.data[0])


def delete(video_id: str, user_id: str) -> LibraryVideoRecord | None:
    """Owner-scoped delete, returning the deleted row (so the caller can read
    video_url/thumbnail_url off it to clean up R2) or None if it didn't
    match -- same convention as set_is_template/update_metadata above, the
    DB delete itself doubling as the ownership check."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .delete()
        .eq("id", video_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        return None
    return LibraryVideoRecord(**result.data[0])
