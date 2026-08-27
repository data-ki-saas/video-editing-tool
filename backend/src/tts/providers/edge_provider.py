import edge_tts

from src.tts.providers.base import SynthesisResult, TTSProvider, VoiceOption, WordTimingResult

# A curated shortlist of well-known, stable Edge neural voices spanning a few
# languages/genders -- NOT the full ~400-voice catalog edge_tts.list_voices()
# would return over the network. This app's whole design philosophy is
# "simple over pro-NLE" (see repo CLAUDE.md's "Driving vision" section): a
# casual creator picking a voiceover voice should see a dozen good options,
# not an unfiltered vendor list. ShortNames below are real, current Edge
# neural voices.
_VOICES = [
    VoiceOption(id="en-US-AriaNeural", label="Aria (US English, female)", locale="en-US", gender="female"),
    VoiceOption(id="en-US-GuyNeural", label="Guy (US English, male)", locale="en-US", gender="male"),
    VoiceOption(id="en-GB-SoniaNeural", label="Sonia (UK English, female)", locale="en-GB", gender="female"),
    VoiceOption(id="en-GB-RyanNeural", label="Ryan (UK English, male)", locale="en-GB", gender="male"),
    VoiceOption(id="en-IN-NeerjaNeural", label="Neerja (Indian English, female)", locale="en-IN", gender="female"),
    VoiceOption(id="en-AU-NatashaNeural", label="Natasha (Australian English, female)", locale="en-AU", gender="female"),
    VoiceOption(id="es-ES-ElviraNeural", label="Elvira (Spanish, female)", locale="es-ES", gender="female"),
    VoiceOption(id="es-MX-DaliaNeural", label="Dalia (Mexican Spanish, female)", locale="es-MX", gender="female"),
    VoiceOption(id="fr-FR-DeniseNeural", label="Denise (French, female)", locale="fr-FR", gender="female"),
    VoiceOption(id="de-DE-KatjaNeural", label="Katja (German, female)", locale="de-DE", gender="female"),
    VoiceOption(id="hi-IN-SwaraNeural", label="Swara (Hindi, female)", locale="hi-IN", gender="female"),
    VoiceOption(id="pt-BR-FranciscaNeural", label="Francisca (Brazilian Portuguese, female)", locale="pt-BR", gender="female"),
]

# Trailing padding added to the last WordBoundary's end offset to cover the
# bit of trailing silence/breath edge-tts's word timings don't account for --
# see the duration comment in synthesize() below.
_DURATION_PADDING_SECONDS = 0.3


def _signed_percent(value: int) -> str:
    return f"{value:+d}%"


def _signed_hz(value: int) -> str:
    return f"{value:+d}Hz"


class EdgeTTSProvider(TTSProvider):
    """Wraps the unofficial Microsoft Edge Read-Aloud API via the Python
    edge-tts package -- same protocol/voices as the JS edge-tts-universal
    package. No API key: it's the same endpoint the Edge browser's
    Read Aloud feature itself calls."""

    async def synthesize(self, text: str, voice: str, rate: int, pitch: int) -> SynthesisResult:
        communicate = edge_tts.Communicate(text, voice, rate=_signed_percent(rate), pitch=_signed_hz(pitch))

        audio_chunks = bytearray()
        word_timings: list[WordTimingResult] = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.extend(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                # offset/duration are in 100-nanosecond units (.NET ticks) --
                # divide by 10_000 to get milliseconds.
                start_ms = chunk["offset"] // 10_000
                end_ms = (chunk["offset"] + chunk["duration"]) // 10_000
                word_timings.append(WordTimingResult(word=chunk["text"], start_ms=start_ms, end_ms=end_ms))

        # There's no cheap way to get an MP3's exact duration without
        # decoding it, and this backend deliberately has no audio-processing
        # dependency (see stock_media/service.py's equivalent reasoning for
        # images). The last word boundary's end offset plus a little padding
        # for trailing silence is the pragmatic value edge-tts users rely on.
        if word_timings:
            duration_seconds = word_timings[-1].end_ms / 1000 + _DURATION_PADDING_SECONDS
        else:
            duration_seconds = 0.0

        return SynthesisResult(
            audio_bytes=bytes(audio_chunks), duration_seconds=duration_seconds, word_timings=word_timings
        )

    def list_voices(self) -> list[VoiceOption]:
        return list(_VOICES)
