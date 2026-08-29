from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class AvatarVideoHandle:
    # The provider's own id for the in-progress job -- used as this app's
    # own avatar_generations.id too (see repository.py), so there's never a
    # second id to map between when a webhook delivery arrives bearing only
    # the provider's id.
    provider_video_id: str


@dataclass
class AvatarOption:
    id: str
    name: str
    preview_image_url: str | None
    gender: str | None
    # "portrait" | "landscape" | "square" | None -- lets the picker sort/
    # filter for what actually fits this app's fixed 9:16 output, unlike
    # TTS's voice list which has no equivalent "does this fit" dimension.
    preferred_orientation: str | None


class AvatarProvider(ABC):
    """A talking-avatar video backend: takes narration audio that already
    exists (e.g. this app's own TTS output) and a chosen avatar, and returns
    a lip-synced video. Mirrors llm/providers/base.py's LLMProvider and
    tts/providers/base.py's TTSProvider shape -- callers (avatar/service.py)
    never depend on a specific vendor's SDK or webhook payload shape.
    """

    @abstractmethod
    async def create_video(
        self, *, audio_url: str, avatar_id: str, aspect_ratio: str, callback_url: str
    ) -> AvatarVideoHandle:
        """Kicks off an async avatar-video render lip-synced to the audio at
        `audio_url` -- does not wait for completion. The provider is expected
        to POST to `callback_url` once the video is ready (see
        verify_webhook and parse_webhook below)."""

    @abstractmethod
    def verify_webhook(self, *, raw_body: bytes, headers: dict[str, str], query_secret: str | None) -> bool:
        """Whether an inbound webhook request is genuinely from this
        provider -- checked BEFORE parse_webhook ever looks at the body."""

    @abstractmethod
    def parse_webhook(self, payload: dict) -> "AvatarWebhookEvent":
        """Turns a verified webhook's JSON body into a normalized event."""

    @abstractmethod
    async def list_avatars(self) -> list[AvatarOption]:
        """A live catalog call (unlike TTSProvider.list_voices' curated
        static shortlist) -- an avatar is inherently visual, so a picker
        needs real names/thumbnails, not just ids. Callers should cache
        this rather than calling it per-request (see avatar/service.py)."""


@dataclass
class AvatarWebhookEvent:
    provider_video_id: str
    status: str  # "completed" | "failed"
    video_url: str | None
    error: str | None
