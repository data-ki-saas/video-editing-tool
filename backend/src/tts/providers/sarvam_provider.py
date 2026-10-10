import base64
import io
import logging
import wave

import httpx
from fastapi import HTTPException

from src.core.config import settings
from src.tts.providers.base import SynthesisResult, TTSProvider, VoiceOption, WordTimingResult

logger = logging.getLogger(__name__)

_API_URL = "https://api.sarvam.ai/text-to-speech"

# Sarvam rejects a single request over this many characters for bulbul:v2.
MAX_CHARS = 1500

# Voice ids are "sarvam:<speaker>:<locale>" -- Sarvam speakers are language-
# independent, the language is a request parameter, so the catalog is the
# cross product of two speakers and the languages this app supports (mirrors
# edge_provider.py's language set; locale uses this app's "or-IN" for Odia,
# which Sarvam spells "od-IN" -- see _SARVAM_LANGUAGE_CODES).
ID_PREFIX = "sarvam:"
_SPEAKERS = [("anushka", "Anushka", "female"), ("abhilash", "Abhilash", "male")]
_LANGUAGES = [
    ("hi-IN", "Hindi"),
    ("en-IN", "Indian English"),
    ("pa-IN", "Punjabi"),
    ("bn-IN", "Bengali"),
    ("mr-IN", "Marathi"),
    ("ta-IN", "Tamil"),
    ("or-IN", "Odia"),
    ("te-IN", "Telugu"),
    ("kn-IN", "Kannada"),
    ("ml-IN", "Malayalam"),
    ("gu-IN", "Gujarati"),
]
_SARVAM_LANGUAGE_CODES = {"or-IN": "od-IN"}

_VOICES = [
    VoiceOption(
        id=f"{ID_PREFIX}{speaker}:{locale}",
        label=f"{name} (Sarvam, {language}, {gender})",
        locale=locale,
        gender=gender,
        provider="sarvam",
    )
    for locale, language in _LANGUAGES
    for speaker, name, gender in _SPEAKERS
]
_VOICE_IDS = {v.id for v in _VOICES}


def is_sarvam_voice(voice_id: str) -> bool:
    return voice_id.startswith(ID_PREFIX)


def parse_voice(voice_id: str) -> tuple[str, str]:
    """Returns (speaker, locale) for a catalog voice id."""
    if voice_id not in _VOICE_IDS:
        raise HTTPException(status_code=400, detail="Unknown voice")
    _, speaker, locale = voice_id.split(":")
    return speaker, locale


def _estimate_word_timings(text: str, duration_seconds: float) -> list[WordTimingResult]:
    """Sarvam returns audio only, no word boundaries, so karaoke captions get
    timings spread over the real duration in proportion to word length --
    close enough to read along with, though not as exact as edge-tts."""
    words = text.split()
    if not words or duration_seconds <= 0:
        return []
    weights = [len(w) + 1 for w in words]
    total = sum(weights)
    total_ms = duration_seconds * 1000
    timings = []
    cursor = 0.0
    for word, weight in zip(words, weights):
        end = cursor + total_ms * weight / total
        timings.append(WordTimingResult(word=word, start_ms=int(cursor), end_ms=int(end)))
        cursor = end
    return timings


def _wav_duration_seconds(wav_bytes: bytes) -> float:
    with wave.open(io.BytesIO(wav_bytes)) as wav:
        return wav.getnframes() / wav.getframerate()


class SarvamTTSProvider(TTSProvider):
    """Sarvam AI Bulbul text-to-speech -- paid, per-character, higher quality
    Indian-language voices. Returns WAV audio."""

    async def synthesize(self, text: str, voice: str, rate: int, pitch: int) -> SynthesisResult:
        if not settings.sarvam_api_key:
            raise HTTPException(status_code=503, detail="Premium voices aren't configured.")
        speaker, locale = parse_voice(voice)
        payload = {
            "text": text,
            "target_language_code": _SARVAM_LANGUAGE_CODES.get(locale, locale),
            "speaker": speaker,
            "model": settings.sarvam_model,
            "pace": max(0.5, min(2.0, 1 + rate / 100)),
            "pitch": max(-0.75, min(0.75, pitch / 100)),
            "enable_preprocessing": True,
        }
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                response = await client.post(
                    _API_URL, json=payload, headers={"api-subscription-key": settings.sarvam_api_key}
                )
            response.raise_for_status()
            wav_bytes = base64.b64decode(response.json()["audios"][0])
            duration = _wav_duration_seconds(wav_bytes)
        except Exception as exc:
            logger.error("sarvam tts failed for voice=%s: %s", voice, exc)
            raise HTTPException(
                status_code=502, detail="The premium voiceover service didn't respond -- please try again."
            ) from exc

        return SynthesisResult(
            audio_bytes=wav_bytes, duration_seconds=duration, word_timings=_estimate_word_timings(text, duration)
        )

    def list_voices(self) -> list[VoiceOption]:
        return list(_VOICES)
