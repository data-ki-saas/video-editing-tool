"""Sarvam premium TTS: voice routing, credit spend-before-call, refund on
provider failure. The credit SQL functions need a real Supabase and are not
exercised -- these pin the Python contract around them."""

import pytest
from fastapi import HTTPException

from src.core.auth import CurrentUser
from src.core.config import settings
from src.credits import service as credits_service
from src.tts import service as tts_service
from src.tts.client import get_tts_provider
from src.tts.providers import sarvam_provider
from src.tts.providers.base import SynthesisResult
from src.tts.providers.sarvam_provider import SarvamTTSProvider, _estimate_word_timings, parse_voice

FREE = CurrentUser(
    id="free-user", email="f@example.com", role="free_user", role_label="Free", features=frozenset({"tts_synthesize"})
)


def test_voice_routing_and_odia_code():
    assert isinstance(get_tts_provider("sarvam:ritu:hi-IN"), SarvamTTSProvider)
    assert not isinstance(get_tts_provider("hi-IN-SwaraNeural"), SarvamTTSProvider)
    assert parse_voice("sarvam:shubh:or-IN") == ("shubh", "or-IN")
    with pytest.raises(HTTPException):
        parse_voice("sarvam:nobody:hi-IN")


def test_script_check_uses_sarvam_locale():
    tts_service._assert_script_matches_voice("नमस्ते", "sarvam:ritu:hi-IN")
    with pytest.raises(HTTPException):
        tts_service._assert_script_matches_voice("நன்றி", "sarvam:ritu:hi-IN")


def test_word_timings_cover_duration():
    timings = _estimate_word_timings("one two three", 3.0)
    assert [t.word for t in timings] == ["one", "two", "three"]
    assert timings[0].start_ms == 0 and abs(timings[-1].end_ms - 3000) <= 1


class _Provider:
    def __init__(self, fail=False):
        self.fail = fail

    async def synthesize(self, text, voice, rate, pitch):
        if self.fail:
            raise HTTPException(status_code=502, detail="down")
        return SynthesisResult(audio_bytes=b"x", duration_seconds=1.0, word_timings=[])


@pytest.fixture
def sarvam_env(monkeypatch):
    spent, refunded = [], []
    monkeypatch.setattr(settings, "sarvam_api_key", "k")
    monkeypatch.setattr(tts_service.limits, "reserve", lambda **kw: None)
    monkeypatch.setattr(credits_service, "spend", lambda uid, res, amt, grant, noun: spent.append(amt))
    monkeypatch.setattr(credits_service, "refund", lambda uid, res, amt: refunded.append(amt))
    return spent, refunded, monkeypatch


async def test_spends_characters_then_calls_provider(sarvam_env):
    spent, refunded, mp = sarvam_env
    mp.setattr(tts_service, "get_tts_provider", lambda voice=None: _Provider())
    await tts_service._synthesize_sarvam("p", "नमस्ते", "sarvam:ritu:hi-IN", 0, 0, FREE)
    assert spent == [6] and refunded == []


async def test_refunds_when_provider_fails(sarvam_env):
    spent, refunded, mp = sarvam_env
    mp.setattr(tts_service, "get_tts_provider", lambda voice=None: _Provider(fail=True))
    with pytest.raises(HTTPException):
        await tts_service._synthesize_sarvam("p", "hello", "sarvam:ritu:en-IN", 0, 0, FREE)
    assert spent == [5] and refunded == [5]


async def test_rejects_over_limit_and_unconfigured(sarvam_env):
    _, _, mp = sarvam_env
    with pytest.raises(HTTPException) as exc:
        await tts_service._synthesize_sarvam("p", "a" * (sarvam_provider.MAX_CHARS + 1), "sarvam:ritu:en-IN", 0, 0, FREE)
    assert exc.value.status_code == 400
    mp.setattr(settings, "sarvam_api_key", "")
    with pytest.raises(HTTPException) as exc:
        await tts_service._synthesize_sarvam("p", "hi", "sarvam:ritu:en-IN", 0, 0, FREE)
    assert exc.value.status_code == 503
