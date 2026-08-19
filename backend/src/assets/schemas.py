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
    public_url: str
    created_at: str
