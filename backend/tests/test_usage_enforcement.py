"""Spend/storage enforcement: the reserve-before-spend, fail-closed behavior
introduced by migration 0043. The SQL functions themselves need a real
Supabase and are NOT exercised here -- these tests pin the Python contract
around them (what is refused, what is reserved first, what fails closed)."""

import pytest
from fastapi import HTTPException

from src.assets import repository as assets_repository
from src.avatar_gen import service as avatar_service
from src.avatar_gen.photo_analysis import FacePalette
from src.core.auth import CurrentUser
from src.core.config import settings
from src.matting import repository as matting_repository
from src.matting import service as matting_service
from src.metering import repository as metering_repository
from src.metering import service as metering_service
from src.storage import quota
from src.usage import limits
from tests.conftest import TEST_USER

FREE = CurrentUser(
    id="free-user", email="f@example.com", role="free_user", role_label="Free", features=frozenset({"assets_manage"})
)
PAID = CurrentUser(
    id="paid-user",
    email="p@example.com",
    role="paid_user",
    role_label="Paid",
    features=frozenset({"matting_generate", "avatar_generate", "assets_manage"}),
)


@pytest.fixture
def cap_hits(monkeypatch):
    hits = []
    monkeypatch.setattr(metering_service, "record_cap_hit", lambda **kw: hits.append(kw))
    return hits


def _reserve_returning(monkeypatch, outcome):
    calls = []

    def fake(**kwargs):
        calls.append(kwargs)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(limits, "_call_reserve", fake)
    return calls


def _reserve(user=PAID, **overrides):
    kwargs = dict(
        user=user, event_type="background_removal", feature="background_removal", noun="things", user_cap=3, global_cap=10, cost_cents=5.0
    )
    kwargs.update(overrides)
    limits.reserve(**kwargs)


# --- limits.reserve ---------------------------------------------------------


def test_reserve_ok_passes_caps_through(monkeypatch):
    calls = _reserve_returning(monkeypatch, {"status": "ok", "user_count": 1})
    _reserve()
    assert calls == [{"user_id": "paid-user", "event_type": "background_removal", "user_cap": 3, "global_cap": 10, "cost_cents": 5.0}]


def test_user_cap_is_429_and_logged(monkeypatch, cap_hits):
    _reserve_returning(monkeypatch, {"status": "user_cap", "user_count": 3})
    with pytest.raises(HTTPException) as exc:
        _reserve()
    assert exc.value.status_code == 429
    assert cap_hits[0]["feature"] == "background_removal" and cap_hits[0]["cap_value"] == 3


@pytest.mark.parametrize("status", ["global_cap", "global_budget"])
def test_site_wide_limits_are_503_and_logged(monkeypatch, cap_hits, status):
    _reserve_returning(monkeypatch, {"status": status, "global_count": 10, "global_cost_cents": 499})
    with pytest.raises(HTTPException) as exc:
        _reserve()
    assert exc.value.status_code == 503
    assert cap_hits[0]["feature"].startswith("background_removal_")


def test_reservation_fails_closed_on_database_error(monkeypatch):
    _reserve_returning(monkeypatch, RuntimeError("supabase down"))
    with pytest.raises(HTTPException) as exc:
        _reserve()
    assert exc.value.status_code == 503


def test_malformed_reservation_response_fails_closed(monkeypatch):
    _reserve_returning(monkeypatch, None)
    with pytest.raises(HTTPException) as exc:
        _reserve()
    assert exc.value.status_code == 503


def test_unknown_status_is_refused_not_allowed(monkeypatch, cap_hits):
    _reserve_returning(monkeypatch, {"status": "something_new"})
    with pytest.raises(HTTPException) as exc:
        _reserve()
    assert exc.value.status_code == 503


def test_admin_skips_count_caps_but_still_reserves_cost(monkeypatch):
    calls = _reserve_returning(monkeypatch, {"status": "ok"})
    _reserve(user=TEST_USER)
    assert calls[0]["user_cap"] is None and calls[0]["global_cap"] is None
    assert calls[0]["cost_cents"] == 5.0


def test_admin_is_still_stopped_by_the_site_wide_budget(monkeypatch, cap_hits):
    _reserve_returning(monkeypatch, {"status": "global_budget", "global_cost_cents": 500})
    with pytest.raises(HTTPException) as exc:
        _reserve(user=TEST_USER)
    assert exc.value.status_code == 503


# --- storage quota ----------------------------------------------------------


def test_quota_blocks_bytes_over_limit(monkeypatch):
    monkeypatch.setattr(quota, "_fetch_usage", lambda user_id: (settings.storage_quota_mb * 1024 * 1024 - 10, 5))
    with pytest.raises(HTTPException) as exc:
        quota.assert_can_store(FREE, adding_bytes=11)
    assert exc.value.status_code == 429
    quota.assert_can_store(FREE, adding_bytes=10)  # exactly at the limit is fine


def test_quota_blocks_object_count(monkeypatch):
    monkeypatch.setattr(quota, "_fetch_usage", lambda user_id: (0, settings.max_objects_per_user))
    with pytest.raises(HTTPException) as exc:
        quota.assert_can_store(FREE, adding_bytes=1)
    assert exc.value.status_code == 429


def test_quota_fails_closed_on_lookup_error(monkeypatch):
    def boom(user_id):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(quota, "_fetch_usage", boom)
    with pytest.raises(HTTPException) as exc:
        quota.assert_can_store(FREE, adding_bytes=1)
    assert exc.value.status_code == 503


def test_quota_admin_bypass(monkeypatch):
    monkeypatch.setattr(quota, "_fetch_usage", lambda user_id: (10**15, 10**9))
    quota.assert_can_store(TEST_USER, adding_bytes=10**9)


async def test_upload_over_quota_is_refused_before_anything_is_written(client, fake_assets_table, monkeypatch):
    from src.core.auth import get_current_user
    from src.main import app

    monkeypatch.setattr(quota, "_fetch_usage", lambda user_id: (settings.storage_quota_mb * 1024 * 1024, 1))
    app.dependency_overrides[get_current_user] = lambda: FREE
    project_id = fake_assets_table.add_project(FREE.id)
    response = await client.post(
        "/api/assets", params={"project_id": project_id}, files={"file": ("a.png", b"png-bytes", "image/png")}
    )
    assert response.status_code == 429
    assert fake_assets_table.assets == {}


# --- matting ----------------------------------------------------------------


class _FakeProvider:
    def __init__(self):
        self.created = 0

    async def create_matte(self, *, video_url, callback_url):
        self.created += 1

        class Handle:
            provider_job_id = "job-1"

        return Handle()


@pytest.fixture
def matting_env(monkeypatch):
    monkeypatch.setattr(settings, "backend_public_url", "https://api.example.com")
    monkeypatch.setattr(settings, "fal_webhook_secret", "s3cret")
    asset = assets_repository.AssetRecord(
        id="asset-1",
        project_id="proj-1",
        uploaded_by=PAID.id,
        filename="clip.mp4",
        kind="video",
        mime_type="video/mp4",
        size_bytes=1000,
        storage_key="projects/proj-1/clip.mp4",
        created_at="2026-01-01T00:00:00Z",
    )
    monkeypatch.setattr(assets_repository, "project_owned_by", lambda project_id, owner_id: True)
    monkeypatch.setattr(assets_repository, "get_asset", lambda asset_id, owner_id: asset)
    monkeypatch.setattr(matting_repository, "get_by_source_asset", lambda source_asset_id, user_id: None)
    created = []
    monkeypatch.setattr(matting_repository, "create", lambda **kw: created.append(kw))
    provider = _FakeProvider()
    monkeypatch.setattr(matting_service, "get_matting_provider", lambda: provider)
    return provider, created


async def test_matting_rejects_clips_over_the_duration_ceiling_without_reserving_or_calling_fal(monkeypatch, matting_env):
    provider, created = matting_env
    calls = _reserve_returning(monkeypatch, {"status": "ok"})

    async def long_clip(asset):
        return float(settings.matting_max_source_seconds) + 1

    monkeypatch.setattr(matting_service, "_probe_source_duration_seconds", long_clip)
    with pytest.raises(HTTPException) as exc:
        await matting_service.request("proj-1", "asset-1", PAID)
    assert exc.value.status_code == 400
    assert calls == [] and provider.created == 0


async def test_matting_reserves_the_clips_real_cost_before_calling_fal(monkeypatch, matting_env):
    provider, created = matting_env
    order = []
    monkeypatch.setattr(limits, "_call_reserve", lambda **kw: order.append(("reserve", kw)) or {"status": "ok"})

    async def clip(asset):
        return 40.0

    monkeypatch.setattr(matting_service, "_probe_source_duration_seconds", clip)
    original = provider.create_matte

    async def tracked(**kw):
        order.append(("fal", None))
        return await original(**kw)

    provider.create_matte = tracked
    await matting_service.request("proj-1", "asset-1", PAID)

    assert [step for step, _ in order] == ["reserve", "fal"]
    reserved = order[0][1]
    assert reserved["cost_cents"] == pytest.approx(40.0 * settings.veed_cost_cents_per_second)
    assert reserved["user_cap"] == settings.matting_daily_cap and reserved["global_cap"] == settings.matting_global_daily_cap


async def test_matting_never_calls_fal_when_the_reservation_is_refused(monkeypatch, matting_env, cap_hits):
    provider, created = matting_env
    _reserve_returning(monkeypatch, {"status": "user_cap", "user_count": 20})

    async def clip(asset):
        return 10.0

    monkeypatch.setattr(matting_service, "_probe_source_duration_seconds", clip)
    with pytest.raises(HTTPException) as exc:
        await matting_service.request("proj-1", "asset-1", PAID)
    assert exc.value.status_code == 429
    assert provider.created == 0 and created == []


async def test_matting_never_calls_fal_when_the_database_is_down(monkeypatch, matting_env):
    provider, _ = matting_env
    _reserve_returning(monkeypatch, RuntimeError("supabase down"))

    async def clip(asset):
        return 10.0

    monkeypatch.setattr(matting_service, "_probe_source_duration_seconds", clip)
    with pytest.raises(HTTPException) as exc:
        await matting_service.request("proj-1", "asset-1", PAID)
    assert exc.value.status_code == 503
    assert provider.created == 0


async def test_unmeasurable_clip_is_refused(monkeypatch, matting_env):
    provider, _ = matting_env
    calls = _reserve_returning(monkeypatch, {"status": "ok"})

    def broken(storage_key):
        raise RuntimeError("not an mp4")

    monkeypatch.setattr(matting_service, "_probe_source_duration_sync", broken)
    with pytest.raises(HTTPException) as exc:
        await matting_service.request("proj-1", "asset-1", PAID)
    assert exc.value.status_code == 400
    assert calls == [] and provider.created == 0


async def test_misconfigured_server_does_not_burn_a_reservation(monkeypatch, matting_env):
    monkeypatch.setattr(settings, "fal_webhook_secret", "")
    calls = _reserve_returning(monkeypatch, {"status": "ok"})
    with pytest.raises(HTTPException) as exc:
        await matting_service.request("proj-1", "asset-1", PAID)
    assert exc.value.status_code == 500
    assert calls == []


async def test_replayed_webhook_for_a_finished_job_does_nothing(monkeypatch):
    record = matting_repository.BackgroundRemovalRecord(
        id="job-1", source_asset_id="asset-1", user_id="paid-user", status="completed", matte_asset_id="m", error=None, created_at="x"
    )
    monkeypatch.setattr(matting_repository, "get_by_id", lambda id: record)

    class Provider:
        def verify_webhook(self, **kw):
            return True

        def parse_webhook(self, payload):
            class Event:
                provider_job_id = "job-1"
                status = "completed"
                matte_url = "https://fal.example/matte.mp4"
                error = None

            return Event()

    monkeypatch.setattr(matting_service, "get_matting_provider", lambda: Provider())
    stored = []
    monkeypatch.setattr(matting_service, "store_asset_bytes", lambda **kw: stored.append(kw))
    recorded = []
    monkeypatch.setattr(metering_repository, "record_event", lambda **kw: recorded.append(kw))

    await matting_service.handle_webhook(raw_body=b"{}", headers={}, query_secret="x")
    assert stored == [] and recorded == []


# --- avatar generation (fal.ai cartoonify) -----------------------------------


def _detected_palette():
    return FacePalette(skin_tone="#c68642", hair_tone="#222222", detected=True)


@pytest.fixture
def avatar_env(monkeypatch):
    monkeypatch.setattr(avatar_service, "analyze_photo", lambda photo_bytes: _detected_palette())
    monkeypatch.setattr(avatar_service.repository, "count_for_user", lambda user_id: 0)
    events = []
    monkeypatch.setattr(metering_repository, "record_event", lambda **kw: events.append(kw))
    return events


async def test_avatar_generation_reserves_before_any_work_and_never_spends_when_refused(monkeypatch, avatar_env, cap_hits):
    _reserve_returning(monkeypatch, {"status": "user_cap", "user_count": 10})
    spent = []

    async def should_not_run(**kw):
        spent.append(kw)
        return True, None

    monkeypatch.setattr(avatar_service, "_cartoonify_and_crop", should_not_run)
    with pytest.raises(HTTPException) as exc:
        await avatar_service.generate_avatar_from_photo(user=PAID, name=None, file_content_type="image/png", photo_bytes=b"x")
    assert exc.value.status_code == 429
    assert spent == []


async def test_avatar_generation_meters_fal_spend_even_when_its_output_is_unusable(monkeypatch, avatar_env):
    calls = _reserve_returning(monkeypatch, {"status": "ok"})

    async def paid_but_unusable(**kw):
        return True, None  # fal.ai was called (and billed); its output had no face

    monkeypatch.setattr(avatar_service, "_cartoonify_and_crop", paid_but_unusable)
    monkeypatch.setattr(avatar_service, "build_atlas_png", lambda palette: (b"png", {}))

    def fail_insert(**kw):
        raise RuntimeError("db down")

    monkeypatch.setattr(avatar_service.repository, "create", fail_insert)

    with pytest.raises(HTTPException):
        await avatar_service.generate_avatar_from_photo(user=PAID, name=None, file_content_type="image/png", photo_bytes=b"x")

    assert calls[0]["cost_cents"] == settings.cartoonify_cost_cents_per_image
    assert len(avatar_env) == 1
    assert avatar_env[0]["provider"] == "fal_ai"
    assert avatar_env[0]["cost_estimate_cents"] == settings.cartoonify_cost_cents_per_image


async def test_avatar_generation_with_no_face_never_calls_fal(monkeypatch, avatar_env):
    monkeypatch.setattr(avatar_service, "analyze_photo", lambda photo_bytes: FacePalette(skin_tone="#aaa", hair_tone=None, detected=False))
    _reserve_returning(monkeypatch, {"status": "ok"})

    async def should_not_run(**kw):
        raise AssertionError("fal.ai must not be called without a detected face")

    monkeypatch.setattr(avatar_service, "_cartoonify_and_crop", should_not_run)
    monkeypatch.setattr(avatar_service, "build_atlas_png", lambda palette: (b"png", {}))
    monkeypatch.setattr(avatar_service.repository, "create", lambda **kw: (_ for _ in ()).throw(RuntimeError("stop here")))
    with pytest.raises(HTTPException):
        await avatar_service.generate_avatar_from_photo(user=PAID, name=None, file_content_type="image/png", photo_bytes=b"x")
    assert avatar_env[0]["provider"] == "local" and avatar_env[0]["cost_estimate_cents"] == 0


def test_avatar_ceiling_blocks_duplicate_and_import_loops(monkeypatch):
    monkeypatch.setattr(avatar_service.repository, "count_for_user", lambda user_id: settings.max_avatars_per_user)
    with pytest.raises(HTTPException) as exc:
        avatar_service.assert_avatar_room(PAID)
    assert exc.value.status_code == 429
    avatar_service.assert_avatar_room(TEST_USER)  # admin bypass
