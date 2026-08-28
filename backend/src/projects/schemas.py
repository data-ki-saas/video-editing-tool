from typing import Literal

from pydantic import BaseModel

ThumbnailSource = Literal["frame", "upload"]


class ThumbnailInfo(BaseModel):
    thumbnail_url: str
    thumbnail_source: ThumbnailSource
    thumbnail_time_seconds: float | None
