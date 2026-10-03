import pytest

from src.core.auth import CurrentUser, get_current_user
from src.main import app
from src.metering import repository as metering_repository
from src.pricing import catalog
from src.pricing import repository as pricing_repository
from tests.conftest import TEST_USER

REGULAR = CurrentUser(id="u1", email="u@example.com", role="paid_user", role_label="Paid", features=frozenset({"assets_manage"}))


class _FakeLedgerClient:
    def __init__(self):
        self.inserted = []

    def table(self, name):
        assert name == "usage_ledger"
        return self

    def insert(self, payload):
        self.inserted.append(payload)
        return self

    def execute(self):
        return None


@pytest.fixture
def ledger(monkeypatch):
    fake = _FakeLedgerClient()
    monkeypatch.setattr(metering_repository, "get_supabase_client", lambda: fake)
    return fake


def _record(**overrides):
    kwargs = dict(user_id="u1", event_type="voiceover", provider="edge", quantity=30.0, unit="seconds", cost_estimate_cents=0)
    kwargs.update(overrides)
    metering_repository.record_event(**kwargs)


# --- the price is frozen onto the row at the moment of consumption ----------


def test_event_is_charged_at_the_price_in_force_when_it_happens(monkeypatch, ledger):
    prices = {"voiceover_seconds": 2.0}
    monkeypatch.setattr(pricing_repository, "get_current_price", lambda key: prices.get(key))

    _record()
    prices["voiceover_seconds"] = 5.0  # admin changes the price afterwards
    _record()

    first, second = ledger.inserted
    assert (first["unit_price_cents"], first["charge_cents"]) == (2.0, 60.0)
    assert (second["unit_price_cents"], second["charge_cents"]) == (5.0, 150.0)


def test_tokens_are_priced_per_thousand(monkeypatch, ledger):
    monkeypatch.setattr(pricing_repository, "get_current_price", lambda key: 3.0)
    _record(event_type="llm_completion", provider="deepseek", quantity=2500, unit="tokens")
    assert ledger.inserted[0]["resource_key"] == "llm_tokens"
    assert ledger.inserted[0]["charge_cents"] == pytest.approx(7.5)


def test_never_priced_item_is_free_not_unpriced(monkeypatch, ledger):
    monkeypatch.setattr(pricing_repository, "get_current_price", lambda key: None)
    _record()
    assert ledger.inserted[0]["unit_price_cents"] == 0.0 and ledger.inserted[0]["charge_cents"] == 0.0


def test_price_lookup_failure_still_records_usage_but_flags_it_unpriced(monkeypatch, ledger):
    def boom(key):
        raise RuntimeError("db down")

    monkeypatch.setattr(pricing_repository, "get_current_price", boom)
    _record()
    row = ledger.inserted[0]
    assert row["resource_key"] == "voiceover_seconds"
    assert row["unit_price_cents"] is None and row["charge_cents"] is None


def test_free_consumption_can_be_priced_like_any_other(monkeypatch, ledger):
    """Local avatars cost us nothing, but an admin may still charge for them."""
    monkeypatch.setattr(pricing_repository, "get_current_price", lambda key: 4.0 if key == "avatar_generate_local_image" else None)
    _record(event_type="avatar_generate", provider="local", quantity=1, unit="images")
    row = ledger.inserted[0]
    assert row["resource_key"] == "avatar_generate_local_image"
    assert (row["unit_price_cents"], row["charge_cents"]) == (4.0, 4.0)
    assert row["cost_estimate_cents"] == 0


def test_every_recorded_event_type_has_a_catalog_item():
    recorded = [
        ("voiceover", "edge", "seconds"),
        ("background_removal", "fal_veed", "seconds"),
        ("background_removal", "fal_rembg", "images"),
        ("avatar_generate", "fal_ai", "images"),
        ("avatar_generate", "local", "images"),
        ("llm_completion", "deepseek", "tokens"),
        ("upload", "internal", "megabytes"),
        ("stock_import", "internal", "items"),
        ("recording_upload", "internal", "megabytes"),
        ("library_save", "internal", "megabytes"),
    ]
    keys = [catalog.resolve_key(*row) for row in recorded]
    assert all(key is not None and catalog.get_item(key) for key in keys)
    assert len(set(keys)) == len(keys)  # each is separately priceable


async def test_upload_is_metered_in_megabytes_and_charged_at_the_current_price(client, fake_assets_table, monkeypatch, ledger):
    monkeypatch.setattr(pricing_repository, "get_current_price", lambda key: 2.0 if key == "upload_mb" else None)
    project_id = fake_assets_table.add_project(TEST_USER.id)
    body = b"x" * (2 * 1024 * 1024)
    response = await client.post(
        "/api/assets", params={"project_id": project_id}, files={"file": ("a.png", body, "image/png")}
    )
    assert response.status_code == 201
    row = ledger.inserted[0]
    assert row["event_type"] == "upload" and row["unit"] == "megabytes"
    assert row["quantity"] == pytest.approx(2.0)
    assert row["charge_cents"] == pytest.approx(4.0)


async def test_recording_upload_is_metered(client, fake_recordings_table, monkeypatch, ledger):
    monkeypatch.setattr(pricing_repository, "get_current_price", lambda key: 1.0)
    response = await client.post(
        "/api/recordings", data={"name": "r"}, files={"file": ("p.jpg", b"y" * 1024 * 1024, "image/jpeg")}
    )
    assert response.status_code == 201
    row = ledger.inserted[0]
    assert row["resource_key"] == "recording_upload_mb" and row["charge_cents"] == pytest.approx(1.0)


@pytest.mark.parametrize(
    "event_type,provider,unit,expected",
    [
        ("voiceover", "edge", "seconds", "voiceover_seconds"),
        ("background_removal", "fal_veed", "seconds", "background_removal_video_seconds"),
        ("background_removal", "fal_rembg", "images", "background_removal_image"),
        ("avatar_generate", "fal_ai", "images", "avatar_generate_image"),
        ("avatar_generate", "local", "images", "avatar_generate_local_image"),
        ("upload", "internal", "megabytes", "upload_mb"),
        ("stock_import", "internal", "items", "stock_import_item"),
        ("recording_upload", "internal", "megabytes", "recording_upload_mb"),
        ("library_save", "internal", "megabytes", "library_save_mb"),
        ("llm_completion", "deepseek", "tokens", "llm_tokens"),
        ("render", "x", "seconds", None),
    ],
)
def test_ledger_rows_map_to_catalog_items(event_type, provider, unit, expected):
    assert catalog.resolve_key(event_type, provider, unit) == expected


# --- admin API -----------------------------------------------------------------


@pytest.fixture
def price_table(monkeypatch):
    rows = []  # newest first, like list_prices

    def insert_price(*, resource_key, unit_price_cents, created_by):
        row = {
            "resource_key": resource_key,
            "unit_price_cents": unit_price_cents,
            "effective_from": f"2026-10-0{len(rows) + 1}T00:00:00+00:00",
            "created_by": created_by,
        }
        rows.insert(0, row)
        return row

    monkeypatch.setattr(pricing_repository, "insert_price", insert_price)
    monkeypatch.setattr(pricing_repository, "list_prices", lambda limit=1000: list(rows))
    return rows


async def test_admin_can_list_set_and_see_history(client, price_table):
    listing = await client.get("/api/admin/pricing")
    assert listing.status_code == 200
    voice = next(r for r in listing.json()["resources"] if r["key"] == "voiceover_seconds")
    assert voice["unit_price_cents"] is None

    assert (await client.put("/api/admin/pricing/voiceover_seconds", json={"unit_price_cents": 1.5})).status_code == 200
    response = await client.put("/api/admin/pricing/voiceover_seconds", json={"unit_price_cents": 2.5})
    voice = next(r for r in response.json()["resources"] if r["key"] == "voiceover_seconds")
    assert voice["unit_price_cents"] == 2.5
    assert [h["unit_price_cents"] for h in voice["history"]] == [2.5, 1.5]
    assert price_table[0]["created_by"] == TEST_USER.id


@pytest.mark.parametrize("payload", [{"unit_price_cents": -1}, {"unit_price_cents": 10_000_000}, {"unit_price_cents": "abc"}, {}])
async def test_invalid_prices_are_rejected(client, price_table, payload):
    response = await client.put("/api/admin/pricing/voiceover_seconds", json=payload)
    assert response.status_code == 422
    assert price_table == []


async def test_unknown_item_is_404(client, price_table):
    response = await client.put("/api/admin/pricing/not_a_thing", json={"unit_price_cents": 1})
    assert response.status_code == 404 and price_table == []


async def test_non_admin_cannot_read_or_set_prices(client, price_table):
    app.dependency_overrides[get_current_user] = lambda: REGULAR
    assert (await client.get("/api/admin/pricing")).status_code == 403
    assert (await client.put("/api/admin/pricing/voiceover_seconds", json={"unit_price_cents": 1})).status_code == 403
    assert price_table == []


# --- monthly statement ----------------------------------------------------------


def _ledger_row(key, qty, price, day):
    return {
        "resource_key": key,
        "quantity": qty,
        "unit": "seconds",
        "unit_price_cents": price,
        "charge_cents": None if price is None else qty * price,
        "created_at": f"2026-10-{day:02d}T10:00:00+00:00",
    }


async def test_statement_splits_a_mid_month_price_change_into_separate_lines(client, price_table, monkeypatch):
    seen = {}

    def fetch(user_id, start, end):
        seen.update(user_id=user_id, start=start, end=end)
        return [
            _ledger_row("voiceover_seconds", 10, 1.0, 2),
            _ledger_row("voiceover_seconds", 20, 1.0, 3),
            _ledger_row("voiceover_seconds", 10, 3.0, 20),  # after the price rose
            _ledger_row("voiceover_seconds", 5, None, 21),  # price lookup had failed
            _ledger_row(None, 1, None, 22),  # never-priced event type
        ]

    monkeypatch.setattr(pricing_repository, "fetch_user_ledger_rows", fetch)
    app.dependency_overrides[get_current_user] = lambda: REGULAR
    response = await client.get("/api/usage/billing", params={"month": "2026-10"})
    body = response.json()

    assert seen["user_id"] == "u1"  # always the caller's own rows
    assert seen["start"].startswith("2026-10-01") and seen["end"].startswith("2026-11-01")
    assert [(l["unit_price_cents"], l["quantity"], l["charge_cents"]) for l in body["lines"]] == [(1.0, 30.0, 30.0), (3.0, 10.0, 30.0)]
    assert body["total_cents"] == 60.0
    assert body["unpriced_events"] == 1
    assert {p["key"] for p in body["current_prices"]} == {i.key for i in catalog.RESOURCES}


async def test_december_statement_ends_at_next_january(client, price_table, monkeypatch):
    seen = {}
    monkeypatch.setattr(pricing_repository, "fetch_user_ledger_rows", lambda u, s, e: seen.update(end=e) or [])
    await client.get("/api/usage/billing", params={"month": "2026-12"})
    assert seen["end"].startswith("2027-01-01")


@pytest.mark.parametrize("month", ["2026-13", "2026-1", "october", "2026-10-01"])
async def test_bad_month_is_400(client, price_table, month):
    assert (await client.get("/api/usage/billing", params={"month": month})).status_code == 400
