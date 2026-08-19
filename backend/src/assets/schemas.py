from typing import Literal

from pydantic import BaseModel

AssetKind = Literal["video", "image"]
AssetMimeType = Literal["video/mp4", "image/jpeg", "image/png"]


class AssetInfo(BaseModel):
    id: str
    project_id: str
    uploaded_by: str
    filename: str
    kind: AssetKind
    mime_type: AssetMimeType
    size_bytes: int
    # A presigned R2 URL, valid for settings.r2_signed_url_expires_seconds --
    # NOT a permanent link. Re-fetch the asset (list/upload response) once
    # it expires rather than caching this value long-term.
    url: str
    created_at: str
