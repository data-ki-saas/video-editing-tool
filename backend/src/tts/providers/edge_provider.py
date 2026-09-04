import asyncio
import logging

import edge_tts
from edge_tts.exceptions import EdgeTTSException
from fastapi import HTTPException

from src.tts.providers.base import SynthesisResult, TTSProvider, VoiceOption, WordTimingResult

logger = logging.getLogger(__name__)

# A curated shortlist of well-known, stable Edge neural voices -- NOT the
# full ~400-voice catalog edge_tts.list_voices() would return over the
# network. This app's whole design philosophy is "simple over pro-NLE" (see
# repo CLAUDE.md's "Driving vision" section): a casual creator picking a
# voiceover voice should see a dozen-odd good options, not an unfiltered
# vendor list. ShortNames below are real, current Edge neural voices.
#
# Indian-language voices come first -- this app's script generation
# supports Hindi/Marathi/Punjabi/Bengali/Tamil/Odia (see
# backend/src/niches/service.py's _LANGUAGE_INFO), so those are the
# preferred/most-relevant voices; list order is dropdown order everywhere
# this catalog is shown, so "Indian voices preferred" needs no extra
# frontend sorting. Non-English-non-Indian voices (Spanish/French/German/
# Portuguese) were dropped as "far removed" from this app's actual target
# languages, per product decision.
_VOICES = [
    VoiceOption(id="hi-IN-SwaraNeural", label="Swara (Hindi, female)", locale="hi-IN", gender="female"),
    VoiceOption(id="hi-IN-MadhurNeural", label="Madhur (Hindi, male)", locale="hi-IN", gender="male"),
    VoiceOption(id="en-IN-NeerjaNeural", label="Neerja (Indian English, female)", locale="en-IN", gender="female"),
    VoiceOption(id="en-IN-PrabhatNeural", label="Prabhat (Indian English, male)", locale="en-IN", gender="male"),
    VoiceOption(id="pa-IN-VaaniNeural", label="Vaani (Punjabi, female)", locale="pa-IN", gender="female"),
    VoiceOption(id="pa-IN-OjasNeural", label="Ojas (Punjabi, male)", locale="pa-IN", gender="male"),
    VoiceOption(id="bn-IN-TanishaaNeural", label="Tanishaa (Bengali, female)", locale="bn-IN", gender="female"),
    VoiceOption(id="bn-IN-BashkarNeural", label="Bashkar (Bengali, male)", locale="bn-IN", gender="male"),
    VoiceOption(id="mr-IN-AarohiNeural", label="Aarohi (Marathi, female)", locale="mr-IN", gender="female"),
    VoiceOption(id="mr-IN-ManoharNeural", label="Manohar (Marathi, male)", locale="mr-IN", gender="male"),
    VoiceOption(id="ta-IN-PallaviNeural", label="Pallavi (Tamil, female)", locale="ta-IN", gender="female"),
    VoiceOption(id="ta-IN-ValluvarNeural", label="Valluvar (Tamil, male)", locale="ta-IN", gender="male"),
    VoiceOption(id="or-IN-SubhasiniNeural", label="Subhasini (Odia, female)", locale="or-IN", gender="female"),
    VoiceOption(id="or-IN-SukantNeural", label="Sukant (Odia, male)", locale="or-IN", gender="male"),
    VoiceOption(id="en-US-AriaNeural", label="Aria (US English, female)", locale="en-US", gender="female"),
    VoiceOption(id="en-US-GuyNeural", label="Guy (US English, male)", locale="en-US", gender="male"),
    VoiceOption(id="en-GB-SoniaNeural", label="Sonia (UK English, female)", locale="en-GB", gender="female"),
    VoiceOption(id="en-GB-RyanNeural", label="Ryan (UK English, male)", locale="en-GB", gender="male"),
    VoiceOption(id="en-AU-NatashaNeural", label="Natasha (Australian English, female)", locale="en-AU", gender="female"),
]

# Trailing padding added to the last WordBoundary's end offset to cover the
# bit of trailing silence/breath edge-tts's word timings don't account for --
# see the duration comment in synthesize() below.
_DURATION_PADDING_SECONDS = 0.3

# edge-tts talks to an unofficial, keyless Microsoft endpoint (see
# EdgeTTSProvider's own docstring) -- it occasionally drops a request with
# no audio at all (edge_tts.exceptions.NoAudioReceived, and its sibling
# WebSocketError/UnexpectedResponse/UnknownResponse, all subclasses of
# EdgeTTSException) for reasons on Microsoft's side, not this app's
# parameters. Confirmed 2026-09-04: the exact same (voice, text, rate=0,
# pitch=0) that failed once in production succeeded immediately when
# retried directly against edge-tts -- i.e. transient, not a bad request.
# One retry absorbs that without making the caller re-click "Generate
# speech" themselves.
_MAX_ATTEMPTS = 2
_RETRY_DELAY_SECONDS = 0.5


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
        last_error: EdgeTTSException | None = None
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            if attempt > 1:
                await asyncio.sleep(_RETRY_DELAY_SECONDS)

            # A fresh Communicate per attempt -- it's a single-use streamer,
            # not safely retryable once its stream() has already run.
            #
            # boundary="WordBoundary" is NOT the edge-tts package's own
            # default (it defaults to "SentenceBoundary" as of 7.x) --
            # confirmed 2026-09-04: without this, every synthesis silently
            # returns zero WordBoundary events regardless of voice/language,
            # so word_timings is always empty and karaoke-mode captions
            # (drawKaraokeCaption in the frontend) never draw anything. This
            # isn't a per-language issue -- it broke the moment the
            # installed edge-tts version added this parameter.
            communicate = edge_tts.Communicate(
                text, voice, rate=_signed_percent(rate), pitch=_signed_hz(pitch), boundary="WordBoundary"
            )
            audio_chunks = bytearray()
            word_timings: list[WordTimingResult] = []
            try:
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        audio_chunks.extend(chunk["data"])
                    elif chunk["type"] == "WordBoundary":
                        # offset/duration are in 100-nanosecond units (.NET
                        # ticks) -- divide by 10_000 to get milliseconds.
                        start_ms = chunk["offset"] // 10_000
                        end_ms = (chunk["offset"] + chunk["duration"]) // 10_000
                        word_timings.append(WordTimingResult(word=chunk["text"], start_ms=start_ms, end_ms=end_ms))
            except EdgeTTSException as exc:
                last_error = exc
                logger.warning(
                    "edge-tts attempt %s/%s failed for voice=%s: %s", attempt, _MAX_ATTEMPTS, voice, exc
                )
                continue

            # There's no cheap way to get an MP3's exact duration without
            # decoding it, and this backend deliberately has no audio-
            # processing dependency (see stock_media/service.py's
            # equivalent reasoning for images). The last word boundary's end
            # offset plus a little padding for trailing silence is the
            # pragmatic value edge-tts users rely on.
            duration_seconds = word_timings[-1].end_ms / 1000 + _DURATION_PADDING_SECONDS if word_timings else 0.0

            return SynthesisResult(
                audio_bytes=bytes(audio_chunks), duration_seconds=duration_seconds, word_timings=word_timings
            )

        logger.error("edge-tts failed after %s attempts for voice=%s: %s", _MAX_ATTEMPTS, voice, last_error)
        raise HTTPException(
            status_code=502, detail="The voiceover service didn't respond -- please try again."
        ) from last_error

    def list_voices(self) -> list[VoiceOption]:
        return list(_VOICES)
