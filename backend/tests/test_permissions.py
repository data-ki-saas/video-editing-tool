from src.core.auth import CurrentUser, get_current_user
from src.main import app
from src.permissions.features import FEATURE_KEYS

ADMIN_USER = CurrentUser(
    id="admin-id", email="admin@example.com", role="admin", role_label="Admin", features=frozenset(FEATURE_KEYS)
)
FREE_USER = CurrentUser(
    id="free-id",
    email="free@example.com",
    role="free_user",
    role_label="Free",
    features=frozenset({"assets_manage", "stock_media_use", "projects_manage", "niches_use"}),
)


def _as(user: CurrentUser):
    app.dependency_overrides[get_current_user] = lambda: user


# --- /api/permissions/assert -- the check the Next.js render route calls ---


async def test_assert_feature_allows_when_granted(client):
    _as(ADMIN_USER)
    response = await client.post("/api/permissions/assert", json={"feature": "render_generate"})
    assert response.status_code == 204


async def test_assert_feature_denies_with_structured_body(client):
    _as(FREE_USER)
    response = await client.post("/api/permissions/assert", json={"feature": "tts_synthesize"})
    assert response.status_code == 403
    detail = response.json()["detail"]
    assert detail["code"] == "feature_not_allowed"
    assert detail["feature"] == "tts_synthesize"
    assert detail["role"] == "free_user"
    assert "upgrade_url" in detail


async def test_assert_feature_rejects_unknown_key(client):
    _as(ADMIN_USER)
    response = await client.post("/api/permissions/assert", json={"feature": "not_a_real_feature"})
    assert response.status_code == 400


async def test_my_permissions_reflects_current_user(client):
    _as(FREE_USER)
    response = await client.get("/api/permissions/me")
    assert response.status_code == 200
    body = response.json()
    assert body["role"] == "free_user"
    assert "tts_synthesize" not in body["features"]
    assert "assets_manage" in body["features"]


# --- admin-only role management endpoints ---


async def test_non_admin_cannot_list_roles(client):
    _as(FREE_USER)
    response = await client.get("/api/roles")
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "feature_not_allowed"


async def test_admin_lists_seeded_roles(client, fake_roles_table):
    _as(ADMIN_USER)
    response = await client.get("/api/roles")
    assert response.status_code == 200
    roles = {row["key"]: row for row in response.json()}
    assert set(roles) == {"admin", "free_user", "paid_user"}
    assert "tts_synthesize" not in roles["free_user"]["features"]
    assert "tts_synthesize" in roles["paid_user"]["features"]
    assert "admin_manage_roles" not in roles["paid_user"]["features"]


async def test_admin_creates_role(client, fake_roles_table):
    _as(ADMIN_USER)
    response = await client.post(
        "/api/roles", json={"key": "vip_user", "display_name": "VIP", "badge_color": "#ff0000"}
    )
    assert response.status_code == 201
    body = response.json()
    assert body["key"] == "vip_user"
    assert body["user_count"] == 0
    assert body["features"] == []


async def test_create_role_rejects_duplicate_key(client, fake_roles_table):
    _as(ADMIN_USER)
    response = await client.post("/api/roles", json={"key": "admin", "display_name": "Duplicate"})
    assert response.status_code == 409


async def test_create_role_rejects_invalid_key(client, fake_roles_table):
    _as(ADMIN_USER)
    response = await client.post("/api/roles", json={"key": "Not Valid!", "display_name": "Bad"})
    assert response.status_code == 400


async def test_admin_updates_role_features(client, fake_roles_table):
    _as(ADMIN_USER)
    response = await client.put("/api/roles/free_user/features", json={"features": ["assets_manage", "tts_synthesize"]})
    assert response.status_code == 200
    assert sorted(response.json()["features"]) == ["assets_manage", "tts_synthesize"]


async def test_update_role_features_rejects_unknown_key(client, fake_roles_table):
    _as(ADMIN_USER)
    response = await client.put("/api/roles/free_user/features", json={"features": ["not_a_real_feature"]})
    assert response.status_code == 400


async def test_delete_system_role_is_blocked(client, fake_roles_table):
    _as(ADMIN_USER)
    response = await client.delete("/api/roles/admin")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "role_is_system"


async def test_delete_role_with_users_is_blocked(client, fake_roles_table):
    fake_roles_table.add_user("u1", email="paid@example.com", role="paid_user")
    _as(ADMIN_USER)
    response = await client.delete("/api/roles/paid_user")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "role_has_users"
    assert detail["user_count"] == 1


async def test_delete_empty_non_system_role_succeeds(client, fake_roles_table):
    _as(ADMIN_USER)
    response = await client.delete("/api/roles/paid_user")
    assert response.status_code == 204
    listing = await client.get("/api/roles")
    assert "paid_user" not in {row["key"] for row in listing.json()}


async def test_cannot_remove_admin_access_from_own_current_role(client, fake_roles_table):
    _as(ADMIN_USER)
    remaining = sorted(FEATURE_KEYS - {"admin_manage_roles"})
    response = await client.put("/api/roles/admin/features", json={"features": remaining})
    assert response.status_code == 409


async def test_cannot_strip_the_last_role_holding_admin_access(client, fake_roles_table):
    # A caller whose *current* role still grants admin_manage_roles (e.g. a
    # not-yet-refreshed session) editing a DIFFERENT role than their own,
    # where that other role is the only one left holding admin_manage_roles.
    fake_roles_table.set_role_features("paid_user", [])  # only "admin" holds it now
    caller = CurrentUser(
        id="stale-admin", email="stale@example.com", role="paid_user", role_label="Paid",
        features=frozenset({"admin_manage_roles"}),
    )
    _as(caller)
    remaining = sorted(FEATURE_KEYS - {"admin_manage_roles"})
    response = await client.put("/api/roles/admin/features", json={"features": remaining})
    assert response.status_code == 409


# --- user -> role assignment ---


async def test_list_users_defaults_unassigned_user_to_default_role(client, fake_roles_table):
    fake_roles_table.add_user("u2", email="new@example.com")  # no profiles row yet
    _as(ADMIN_USER)
    response = await client.get("/api/users")
    assert response.status_code == 200
    user = next(u for u in response.json()["users"] if u["id"] == "u2")
    assert user["role"] == "free_user"


async def test_admin_assigns_role_to_user(client, fake_roles_table):
    fake_roles_table.add_user("u3", email="someone@example.com", role="free_user")
    _as(ADMIN_USER)
    response = await client.patch("/api/users/u3/role", json={"role": "paid_user"})
    assert response.status_code == 200
    assert response.json()["role"] == "paid_user"


async def test_admin_cannot_demote_self_away_from_admin_access(client, fake_roles_table):
    fake_roles_table.add_user(ADMIN_USER.id, email=ADMIN_USER.email, role="admin")
    _as(ADMIN_USER)
    response = await client.patch(f"/api/users/{ADMIN_USER.id}/role", json={"role": "paid_user"})
    assert response.status_code == 409
