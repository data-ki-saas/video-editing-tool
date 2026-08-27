from pydantic import BaseModel


class SynthesizeRequest(BaseModel):
    project_id: str
    text: str
    voice: str
    # Signed percent/Hz adjustments passed through to edge_tts as
    # "+0%"/"-20%" and "+0Hz"/"-20Hz" strings -- see
    # tts/providers/edge_provider.py's _signed_percent/_signed_hz.
    rate: int = 0
    pitch: int = 0


class WordTiming(BaseModel):
    word: str
    start_ms: int
    end_ms: int


class SynthesizeResponse(BaseModel):
    asset_id: str
    # A presigned R2 URL straight from the created AssetInfo -- same
    # not-permanent caveat as AssetInfo.url (see assets/schemas.py).
    url: str
    duration_seconds: float
    word_timings: list[WordTiming]


class VoiceOption(BaseModel):
    id: str
    label: str
    locale: str
    gender: str


class VoicesResponse(BaseModel):
    voices: list[VoiceOption]
