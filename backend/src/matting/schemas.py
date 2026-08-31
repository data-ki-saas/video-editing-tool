from typing import Literal

from pydantic import BaseModel

BackgroundRemovalStatus = Literal["waiting", "completed", "failed"]


class RequestBackgroundRemovalRequest(BaseModel):
    project_id: str
    # The clip to matte -- a "video" or "image" asset in this project (see
    # service.request's own kind-based branch: a video job is async/
    # webhook-driven via VEED, a photo job is synchronous via rembg).
    # Keyed by source_asset_id, not a per-cutaway id: see repository.py's
    # get_or_create -- the same clip trimmed into multiple cutaways/segments
    # shares one matting job instead of paying for it again.
    source_asset_id: str


class RequestBackgroundRemovalResponse(BaseModel):
    status: BackgroundRemovalStatus
    # Populated immediately for an image (synchronous) job's response, so
    # the frontend can skip polling entirely in the common case -- still
    # null for a video (async) job, which only ever resolves via the
    # webhook + a later GET /status poll.
    matte_asset_id: str | None = None
    matte_url: str | None = None
    error: str | None = None


class BackgroundRemovalDetail(BaseModel):
    status: BackgroundRemovalStatus
    matte_asset_id: str | None = None
    # Re-derived fresh, never persisted -- same not-permanent-link reasoning
    # as every other asset (see r2_client.presigned_get_url's own comment).
    matte_url: str | None = None
    error: str | None = None
