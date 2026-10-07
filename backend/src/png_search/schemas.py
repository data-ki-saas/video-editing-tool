from pydantic import BaseModel


class PngSearchResult(BaseModel):
    # The Commons file title ("File:Foo.png"). Doubles as the import id -- the
    # download URL is always re-resolved from it server-side.
    id: str
    title: str
    thumbnail_url: str
    width: int | None = None
    height: int | None = None
    # e.g. "CC BY-SA 4.0" / "Public domain", plus a ready-to-show credit line.
    license: str
    attribution: str
    page_url: str


class PngSearchResponse(BaseModel):
    results: list[PngSearchResult]
    page: int
    has_more: bool


class ImportPngRequest(BaseModel):
    project_id: str
    source_id: str
    title: str
