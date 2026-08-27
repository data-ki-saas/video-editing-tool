from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class WordTimingResult:
    word: str
    start_ms: int
    end_ms: int


@dataclass
class SynthesisResult:
    audio_bytes: bytes
    duration_seconds: float
    word_timings: list[WordTimingResult]


@dataclass
class VoiceOption:
    id: str
    label: str
    locale: str
    gender: str


class TTSProvider(ABC):
    """A text-to-speech backend. Implementations wrap a specific vendor's API
    behind these two methods, so callers (tts/service.py) don't depend on any
    provider's SDK or request/response shape directly -- mirrors
    llm/providers/base.py's LLMProvider shape.
    """

    @abstractmethod
    async def synthesize(self, text: str, voice: str, rate: int, pitch: int) -> SynthesisResult:
        """Render `text` to speech in `voice`. `rate`/`pitch` are signed
        percent/Hz adjustments (e.g. -50..50), not the provider's raw
        string format."""

    @abstractmethod
    def list_voices(self) -> list[VoiceOption]:
        """A curated, static shortlist of voices -- never a live catalog
        call (see edge_provider.py for why)."""
