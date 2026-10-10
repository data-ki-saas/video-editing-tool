import logging
import uuid

from fastapi import HTTPException

from src.assets import repository as assets_repository
from src.assets.service import store_asset_bytes
from src.core.auth import CurrentUser, bypasses_daily_caps
from src.core.config import settings
from src.credits import service as credits_service
from src.metering import pricing as metering_pricing
from src.metering import repository as metering_repository
from src.metering import service as metering_service
from src.tts import repository as tts_repository
from src.tts.client import get_tts_provider, sarvam_enabled
from src.tts.providers import sarvam_provider
from src.tts.schemas import SynthesizeResponse, VoiceOption, VoicesResponse, WordTiming
from src.usage import limits

logger = logging.getLogger(__name__)

MAX_TEXT_LENGTH = 2000

# Unicode block ranges for each Indic script this app's niche languages use
# (mirrors niches/service.py's _LANGUAGE_INFO and the frontend's
# lib/transliteration.ts LANGUAGE_SCRIPTS -- add a new Indian language in
# all three places, plus edge_provider.py's voice catalog), paired with
# which voice-id language prefixes can actually read that script.
#
# Confirmed 2026-09-04: edge-tts deterministically fails (NoAudioReceived,
# every time, not flaky) whenever a voice is given text in an Indic script
# outside its own language -- e.g. en-IN-PrabhatNeural or ta-IN-PallaviNeural
# given Devanagari (Hindi) text. An Indic voice reading plain English, or
# English/its-own-script code-switched text, works fine -- so this only
# needs to catch a genuine WRONG-script mismatch, never gate on English.
_SCRIPT_RANGES: list[tuple[str, int, int, frozenset[str]]] = [
    ("Devanagari", 0x0900, 0x097F, frozenset({"hi", "mr"})),
    ("Gurmukhi", 0x0A00, 0x0A7F, frozenset({"pa"})),
    ("Bengali", 0x0980, 0x09FF, frozenset({"bn"})),
    ("Odia", 0x0B00, 0x0B7F, frozenset({"or"})),
    ("Tamil", 0x0B80, 0x0BFF, frozenset({"ta"})),
    ("Gujarati", 0x0A80, 0x0AFF, frozenset({"gu"})),
    ("Telugu", 0x0C00, 0x0C7F, frozenset({"te"})),
    ("Kannada", 0x0C80, 0x0CFF, frozenset({"kn"})),
    ("Malayalam", 0x0D00, 0x0D7F, frozenset({"ml"})),
]


def _assert_script_matches_voice(text: str, voice: str) -> None:
    # Sarvam ids are "sarvam:<speaker>:<locale>"; edge ids start with the locale.
    voice_lang = (voice.split(":")[-1] if sarvam_provider.is_sarvam_voice(voice) else voice).split("-")[0].lower()
    for script_name, start, end, supported_langs in _SCRIPT_RANGES:
        if voice_lang in supported_langs:
            continue
        if any(start <= ord(ch) <= end for ch in text):
            raise HTTPException(
                status_code=400,
                detail=f"This voice can't read {script_name} script -- pick a voice for that language instead.",
            )


async def synthesize(project_id: str, text: str, voice: str, rate: int, pitch: int, user: CurrentUser) -> SynthesizeResponse:
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text is required")
    if len(text) > MAX_TEXT_LENGTH:
        raise HTTPException(status_code=400, detail=f"Text exceeds the {MAX_TEXT_LENGTH} character limit")
    _assert_script_matches_voice(text, voice)

    if not assets_repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")

    use_sarvam = sarvam_provider.is_sarvam_voice(voice)
    extension, content_type = ("wav", "audio/wav") if use_sarvam else ("mp3", "audio/mpeg")
    if use_sarvam:
        result = await _synthesize_sarvam(project_id, text, voice, rate, pitch, user)
    else:
        result = await _synthesize_edge(text, voice, rate, pitch, user)

    asset = store_asset_bytes(
        project_id=project_id,
        user=user,
        filename=f"tts-{uuid.uuid4().hex}.{extension}",
        content_type=content_type,
        kind="audio",
        body=result.audio_bytes,
    )

    # Best-effort -- a failure to record usage shouldn't fail a synthesis
    # that already succeeded and was already stored as an asset.
    if use_sarvam:
        metering_repository.record_event(
            user_id=user.id,
            project_id=project_id,
            event_type="voiceover",
            provider="sarvam",
            quantity=len(text),
            unit="characters",
            cost_estimate_cents=len(text) * settings.sarvam_cost_cents_per_char,
        )
    else:
        tts_repository.record_voiceover_event(user.id)
        metering_repository.record_event(
            user_id=user.id,
            project_id=project_id,
            event_type="voiceover",
            provider=settings.tts_provider,
            quantity=result.duration_seconds,
            unit="seconds",
            cost_estimate_cents=metering_pricing.voiceover_cost_cents(result.duration_seconds),
        )

    return SynthesizeResponse(
        asset_id=asset.id,
        url=asset.url,
        duration_seconds=result.duration_seconds,
        word_timings=[WordTiming(word=w.word, start_ms=w.start_ms, end_ms=w.end_ms) for w in result.word_timings],
    )


async def _synthesize_edge(text: str, voice: str, rate: int, pitch: int, user: CurrentUser):
    # Admin accounts skip the guardrail entirely -- see
    # core/auth.py's bypasses_daily_caps.
    if not bypasses_daily_caps(user):
        # Fails OPEN: a None count means the usage_events read itself
        # errored (see repository.count_recent_voiceover_events), which
        # shouldn't block the feature entirely.
        recent_count = tts_repository.count_recent_voiceover_events(user.id)
        if recent_count is not None and recent_count >= settings.tts_daily_cap:
            metering_service.record_cap_hit(
                user_id=user.id, feature="voiceover", cap_value=settings.tts_daily_cap, count_at_trigger=recent_count + 1
            )
            raise HTTPException(
                status_code=429,
                detail=f"You've reached the limit of {settings.tts_daily_cap} voice generations per day. Try again tomorrow.",
            )

    return await get_tts_provider(voice).synthesize(text, voice, rate, pitch)



async def _synthesize_sarvam(project_id: str, text: str, voice: str, rate: int, pitch: int, user: CurrentUser):
    if not sarvam_enabled():
        raise HTTPException(status_code=503, detail="Premium voices aren't available right now.")
    if len(text) > sarvam_provider.MAX_CHARS:
        raise HTTPException(
            status_code=400, detail=f"Premium voices take up to {sarvam_provider.MAX_CHARS} characters at a time."
        )

    chars = len(text)
    # Daily cap + site-wide cost budget first (admins skip only the count cap),
    # then the user's own credits -- both before any money is spent.
    limits.reserve(
        user=user,
        event_type="voiceover_sarvam",
        feature="voiceover_sarvam",
        noun="premium voice generations",
        user_cap=settings.sarvam_daily_cap,
        cost_cents=chars * settings.sarvam_cost_cents_per_char,
    )
    charged = not bypasses_daily_caps(user)
    if charged:
        credits_service.spend(
            user.id, credits_service.SARVAM_TTS_CHARS, chars, settings.sarvam_trial_credit_chars, "premium voice"
        )
    try:
        return await get_tts_provider(voice).synthesize(text, voice, rate, pitch)
    except HTTPException:
        if charged:
            credits_service.refund(user.id, credits_service.SARVAM_TTS_CHARS, chars)
        raise

def list_voices(user: CurrentUser) -> VoicesResponse:
    voices = list(get_tts_provider().list_voices())
    credits: int | None = None
    unlimited = bypasses_daily_caps(user)
    if sarvam_enabled():
        voices += sarvam_provider.SarvamTTSProvider().list_voices()
        if unlimited:
            credits = 0
        else:
            try:
                credits = credits_service.ensure_and_get_balance(
                    user.id, credits_service.SARVAM_TTS_CHARS, settings.sarvam_trial_credit_chars
                )
            except Exception:
                logger.exception("failed to read sarvam credits for user=%s", user.id)
                credits = 0
    return VoicesResponse(
        voices=[
            VoiceOption(id=v.id, label=v.label, locale=v.locale, gender=v.gender, provider=v.provider) for v in voices
        ],
        sarvam_credits=credits,
        sarvam_unlimited=unlimited,
    )
