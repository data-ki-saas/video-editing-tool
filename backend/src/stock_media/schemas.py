from typing import Literal

from pydantic import BaseModel

StockMediaKind = Literal["photo", "video", "music"]


class StockSearchResult(BaseModel):
    id: str
    kind: StockMediaKind
    title: str
    # For a photo, a small version of the same image -- "pictures are easy",
    # no separate preview step is needed. Empty for music (Freesound gives
    # no artwork).
    thumbnail_url: str
    # What the frontend's "check it in a popup" preview player actually
    # plays for video/music, or shows (a bigger version) for a photo.
    preview_url: str
    duration_seconds: float | None = None
    attribution: str
    width: int | None = None
    height: int | None = None


class StockSearchResponse(BaseModel):
    results: list[StockSearchResult]
    page: int
    has_more: bool


class ImportStockAssetRequest(BaseModel):
    project_id: str
    kind: StockMediaKind
    # Only an id -- never a client-supplied URL. import_stock_asset()
    # re-resolves the actual download URL itself from the provider's own
    # single-item API, so nothing this backend fetches is ever a URL the
    # client got to choose (see stock_media/service.py).
    source_id: str
    # A human-readable name for the imported asset (the search result's own
    # title) -- the actual filename/extension is decided server-side from
    # `kind`, not derived from this.
    filename: str
