from pydantic import BaseModel, Field

# Kept in sync with the migration's own check constraint
# (public_library_assets.asset_type) -- "video"/"image"/"audio" are reserved
# for a future promotion path (see that table's own media_* columns' doc
# comment); only "avatar" has a working promote/import flow today.
LibraryAssetType = str


class LibraryAssetSummary(BaseModel):
    id: str
    asset_type: LibraryAssetType
    title: str
    description: str | None
    thumbnail_url: str | None
    # Set for video/image/audio entries -- the actual public file to
    # play/view/hear before importing (LibraryAssetDialog's own preview) and
    # what import_media_to_project re-downloads server-side. Always null for
    # "avatar" entries, whose playable content IS thumbnail_url (the atlas
    # image -- an avatar has nothing else to preview).
    media_url: str | None = None
    media_mime_type: str | None = None
    media_duration_seconds: float | None = None
    created_at: str


class PromoteAvatarRequest(BaseModel):
    title: str
    description: str | None = None
    # Must be explicitly true -- the checkbox this gates ("I allow anyone to
    # use this asset, with no liability to me") is the one thing standing
    # between a private avatar_designs row and it becoming permanently
    # public, so this is validated server-side (service.promote_avatar),
    # never trusted from a client-side-disabled submit button alone.
    liability_waiver_accepted: bool = Field(default=False)
