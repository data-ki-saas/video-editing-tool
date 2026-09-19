from dataclasses import dataclass

from src.core.supabase_client import get_supabase_client

_TABLE = "public_library_assets"

# Every column the table has -- select("*") returns exactly this set, so
# LibraryAssetRecord(**row) below only works if the dataclass matches it
# completely (same convention as avatar_gen/repository.py's
# AvatarDesignRecord).
_COLUMNS = (
    "id, asset_type, promoted_by, title, description, thumbnail_url, "
    "avatar_skin, avatar_design, media_url, media_mime_type, "
    "media_duration_seconds, liability_waiver_accepted_at, created_at"
)


@dataclass
class LibraryAssetRecord:
    id: str
    asset_type: str
    promoted_by: str
    title: str
    description: str | None
    thumbnail_url: str | None
    avatar_skin: dict | None
    avatar_design: dict | None
    media_url: str | None
    media_mime_type: str | None
    media_duration_seconds: float | None
    liability_waiver_accepted_at: str
    created_at: str


def create_avatar_promotion(
    *, id: str, promoted_by: str, title: str, description: str | None, thumbnail_url: str, avatar_skin: dict, avatar_design: dict
) -> LibraryAssetRecord:
    payload = {
        "id": id,
        "asset_type": "avatar",
        "promoted_by": promoted_by,
        "title": title,
        "description": description,
        "thumbnail_url": thumbnail_url,
        "avatar_skin": avatar_skin,
        "avatar_design": avatar_design,
    }
    result = get_supabase_client().table(_TABLE).insert(payload).execute()
    return LibraryAssetRecord(**result.data[0])


def list_public(asset_type: str | None) -> list[LibraryAssetRecord]:
    query = get_supabase_client().table(_TABLE).select(_COLUMNS)
    if asset_type is not None:
        query = query.eq("asset_type", asset_type)
    result = query.order("created_at", desc=True).execute()
    return [LibraryAssetRecord(**row) for row in result.data]


def get(library_asset_id: str) -> LibraryAssetRecord | None:
    result = get_supabase_client().table(_TABLE).select(_COLUMNS).eq("id", library_asset_id).limit(1).execute()
    if not result.data:
        return None
    return LibraryAssetRecord(**result.data[0])
