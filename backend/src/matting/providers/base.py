from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class MatteJobHandle:
    # The provider's own id for the in-progress job -- used as this app's own
    # background_removals.id too (see repository.py), same reasoning as
    # AvatarVideoHandle.provider_video_id: a webhook delivery only ever
    # carries the provider's id, so there's never a second id to map between.
    provider_job_id: str


class MattingProvider(ABC):
    """Cuts a subject out of existing footage -- two independent
    capabilities, since a video and a still photo need genuinely different
    provider mechanics (async job + webhook vs. a synchronous call), not
    just a smaller/bigger version of the same thing:

    - create_matte: takes a source VIDEO (an already-uploaded project asset)
      and returns a grayscale luma-matte video, frame-aligned with the
      source, that Creatomate's own maskMode: "luma" (see
      compileCreatomateTimeline.ts's buildBackgroundRemovedSegment) uses to
      mask that clip against a new backdrop.
    - create_image_cutout: takes a source PHOTO and returns a real-alpha PNG
      cutout directly -- no separate mask needed, since a still image's own
      transparency already IS the mask (see buildBackgroundRemovedImageSegment).

    Mirrors avatar/providers/base.py's AvatarProvider shape -- callers
    (matting/service.py) never depend on a specific vendor's SDK or webhook
    payload shape.
    """

    @abstractmethod
    async def create_matte(self, *, video_url: str, callback_url: str) -> MatteJobHandle:
        """Kicks off an async matting job for the video at `video_url` --
        does not wait for completion. The provider is expected to POST to
        `callback_url` once the matte is ready (see verify_webhook and
        parse_webhook below)."""

    @abstractmethod
    async def create_image_cutout(self, *, image_url: str) -> str:
        """Synchronously cuts the subject out of the still image at
        `image_url`, returning the URL of a resulting PNG with real alpha
        transparency (background pixels genuinely transparent, not a
        separate mask channel). No callback_url/webhook -- an image-matting
        job is fast enough that matting/service.py just awaits it directly,
        unlike create_matte's async+webhook shape."""

    @abstractmethod
    def verify_webhook(self, *, raw_body: bytes, headers: dict[str, str], query_secret: str | None) -> bool:
        """Whether an inbound webhook request is genuinely from this
        provider -- checked BEFORE parse_webhook ever looks at the body.
        Only ever relevant to create_matte's async video path -- create_image_cutout
        has no webhook to verify."""

    @abstractmethod
    def parse_webhook(self, payload: dict) -> "MatteWebhookEvent":
        """Turns a verified webhook's JSON body into a normalized event."""


@dataclass
class MatteWebhookEvent:
    provider_job_id: str
    status: str  # "completed" | "failed"
    matte_url: str | None
    error: str | None
