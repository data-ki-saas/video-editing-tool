import logging
import uuid

from fastapi import HTTPException

from src.assets import repository as assets_repository
from src.assets.service import store_asset_bytes
from src.core.auth import CurrentUser, bypasses_daily_caps
from src.core.config import settings
from src.metering import pricing as metering_pricing
from src.metering import repository as metering_repository
from src.metering import service as metering_service
from src.tts import repository as tts_repository
from src.tts.client import get_tts_provider
from src.tts.schemas import SynthesizeResponse, VoiceOption, VoicesResponse, WordTiming

logger = logging.getLogger(__name__)

MAX_TEXT_LENGTH = 2000


async def synthesize(project_id: str, text: str, voice: str, rate: int, pitch: int, user: CurrentUser) -> SynthesizeResponse:
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text is required")
    if len(text) > MAX_TEXT_LENGTH:
        raise HTTPException(status_code=400, detail=f"Text exceeds the {MAX_TEXT_LENGTH} character limit")

    if not assets_repository.project_owned_by(project_id, user.id):
        raise HTTPException(status_code=404, detail="Project not found")

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

    result = await get_tts_provider().synthesize(text, voice, rate, pitch)

    asset = store_asset_bytes(
        project_id=project_id,
        user=user,
        filename=f"tts-{uuid.uuid4().hex}.mp3",
        content_type="audio/mpeg",
        kind="audio",
        body=result.audio_bytes,
    )

    # Best-effort -- a failure to record usage shouldn't fail a synthesis
    # that already succeeded and was already stored as an asset.
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


def list_voices() -> VoicesResponse:
    voices = get_tts_provider().list_voices()
    return VoicesResponse(
        voices=[VoiceOption(id=v.id, label=v.label, locale=v.locale, gender=v.gender) for v in voices]
    )
