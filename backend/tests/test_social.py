import time

import pytest
from fastapi import HTTPException

from src.core.config import settings
from src.social import service
from src.social.client import get_social_provider
from src.social.providers.meta_provider import MetaProvider
from src.social.providers.youtube_provider import YouTubeProvider


@pytest.fixture(autouse=True)
def state_secret(monkeypatch):
    monkeypatch.setattr(settings, "social_oauth_state_secret", "test-state-secret")


def test_state_round_trips_to_the_same_user_id():
    state = service._sign_state("user-123")
    assert service._verify_state(state) == "user-123"


def test_state_rejects_a_tampered_signature():
    state = service._sign_state("user-123")
    tampered = state[:-1] + ("0" if state[-1] != "0" else "1")
    with pytest.raises(HTTPException) as excinfo:
        service._verify_state(tampered)
    assert excinfo.value.status_code == 400


def test_state_rejects_a_different_secret_than_it_was_signed_with(monkeypatch):
    state = service._sign_state("user-123")
    monkeypatch.setattr(settings, "social_oauth_state_secret", "a-different-secret")
    with pytest.raises(HTTPException) as excinfo:
        service._verify_state(state)
    assert excinfo.value.status_code == 400


def test_state_rejects_an_expired_attempt(monkeypatch):
    monkeypatch.setattr(time, "time", lambda: 1_000_000)
    state = service._sign_state("user-123")
    monkeypatch.setattr(time, "time", lambda: 1_000_000 + service._STATE_TTL_SECONDS + 1)
    with pytest.raises(HTTPException) as excinfo:
        service._verify_state(state)
    assert excinfo.value.status_code == 400


async def test_handle_callback_surfaces_a_declined_consent_as_a_query_param(monkeypatch):
    monkeypatch.setattr(settings, "frontend_public_url", "https://app.example.com")
    redirect = await service.handle_callback("youtube", None, None, "access_denied")
    assert redirect == "https://app.example.com/settings?social_error=access_denied&provider=youtube"


async def test_handle_callback_rejects_a_forged_state():
    with pytest.raises(HTTPException) as excinfo:
        await service.handle_callback("youtube", "some-code", "not-a-real-state", None)
    assert excinfo.value.status_code == 400


def test_get_social_provider_rejects_an_unknown_platform():
    with pytest.raises(ValueError):
        get_social_provider("tiktok")


def test_get_social_provider_returns_a_youtube_provider(monkeypatch):
    monkeypatch.setattr(settings, "google_oauth_client_id", "client-id")
    monkeypatch.setattr(settings, "google_oauth_client_secret", "client-secret")
    monkeypatch.setattr(settings, "backend_public_url", "https://backend.example.com")
    get_social_provider.cache_clear()
    provider = get_social_provider("youtube")
    assert isinstance(provider, YouTubeProvider)


def test_youtube_authorize_url_carries_the_signed_state_and_forces_reconsent():
    provider = YouTubeProvider(
        client_id="client-id", client_secret="client-secret", redirect_uri="https://backend.example.com/api/social/youtube/callback"
    )
    url = provider.get_authorize_url("the-state-value")
    assert "client_id=client-id" in url
    assert "state=the-state-value" in url
    assert "prompt=consent" in url
    assert "access_type=offline" in url


def test_youtube_provider_requires_configuration():
    provider = YouTubeProvider(client_id="", client_secret="", redirect_uri="https://backend.example.com/cb")
    with pytest.raises(ValueError):
        provider.get_authorize_url("state")


def test_get_social_provider_returns_a_meta_provider_for_both_meta_and_instagram(monkeypatch):
    monkeypatch.setattr(settings, "meta_app_id", "app-id")
    monkeypatch.setattr(settings, "meta_app_secret", "app-secret")
    monkeypatch.setattr(settings, "backend_public_url", "https://backend.example.com")
    get_social_provider.cache_clear()
    meta = get_social_provider("meta")
    instagram = get_social_provider("instagram")
    assert isinstance(meta, MetaProvider)
    assert isinstance(instagram, MetaProvider)


def test_meta_and_instagram_share_the_same_callback_url(monkeypatch):
    monkeypatch.setattr(settings, "meta_app_id", "app-id")
    monkeypatch.setattr(settings, "meta_app_secret", "app-secret")
    monkeypatch.setattr(settings, "backend_public_url", "https://backend.example.com")
    get_social_provider.cache_clear()
    meta_url = get_social_provider("meta").get_authorize_url("the-state-value")
    instagram_url = get_social_provider("instagram").get_authorize_url("the-state-value")
    assert "redirect_uri=https%3A%2F%2Fbackend.example.com%2Fapi%2Fsocial%2Fmeta%2Fcallback" in meta_url
    assert "redirect_uri=https%3A%2F%2Fbackend.example.com%2Fapi%2Fsocial%2Fmeta%2Fcallback" in instagram_url


def test_meta_authorize_url_carries_the_signed_state_and_combined_scope():
    provider = MetaProvider(
        app_id="app-id", app_secret="app-secret", redirect_uri="https://backend.example.com/api/social/meta/callback", platform="meta"
    )
    url = provider.get_authorize_url("the-state-value")
    assert "client_id=app-id" in url
    assert "state=the-state-value" in url
    assert "pages_manage_posts" in url
    assert "instagram_content_publish" in url


def test_meta_provider_requires_configuration():
    provider = MetaProvider(app_id="", app_secret="", redirect_uri="https://backend.example.com/cb", platform="meta")
    with pytest.raises(ValueError):
        provider.get_authorize_url("state")
