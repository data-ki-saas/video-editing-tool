import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from src.core import auth
from src.core.config import settings
from src.permissions import repository as permissions_repository


@pytest.fixture(autouse=True)
def clear_user_cache():
    auth._user_cache.clear()
    yield
    auth._user_cache.clear()


_TEST_SECRET = "test-secret-at-least-32-bytes-long"


@pytest.fixture
def jwt_secret(monkeypatch):
    monkeypatch.setattr(settings, "supabase_jwt_secret", _TEST_SECRET)
    return _TEST_SECRET


@pytest.fixture
def stub_role(monkeypatch):
    monkeypatch.setattr(
        permissions_repository,
        "get_user_role_and_features",
        lambda user_id: ("free_user", "Free", "#64748b", frozenset({"assets_manage"})),
    )


def _make_token(secret: str, *, sub: str = "user-1", email: str = "a@example.com", exp_delta: int = 3600) -> str:
    return jwt.encode(
        {"sub": sub, "email": email, "aud": "authenticated", "exp": int(time.time()) + exp_delta},
        secret,
        algorithm="HS256",
    )


async def test_local_verification_accepts_valid_token(jwt_secret, stub_role):
    token = _make_token(jwt_secret)
    user = await auth.get_current_user(authorization=f"Bearer {token}")
    assert user.id == "user-1"
    assert user.email == "a@example.com"
    assert user.role == "free_user"


async def test_local_verification_rejects_expired_token(jwt_secret, stub_role):
    token = _make_token(jwt_secret, exp_delta=-10)
    with pytest.raises(Exception) as excinfo:
        await auth.get_current_user(authorization=f"Bearer {token}")
    assert getattr(excinfo.value, "status_code", None) == 401


async def test_local_verification_rejects_wrong_secret(jwt_secret, stub_role):
    token = _make_token("a-different-secret")
    with pytest.raises(Exception) as excinfo:
        await auth.get_current_user(authorization=f"Bearer {token}")
    assert getattr(excinfo.value, "status_code", None) == 401


async def test_second_call_uses_cache_not_role_lookup(jwt_secret, monkeypatch):
    calls = []
    monkeypatch.setattr(
        permissions_repository,
        "get_user_role_and_features",
        lambda user_id: calls.append(user_id) or ("free_user", "Free", "#64748b", frozenset()),
    )
    token = _make_token(jwt_secret)

    first = await auth.get_current_user(authorization=f"Bearer {token}")
    second = await auth.get_current_user(authorization=f"Bearer {token}")

    assert first.id == second.id == "user-1"
    assert len(calls) == 1


async def test_local_verification_accepts_valid_es256_token(jwt_secret, stub_role, monkeypatch):
    """Covers Supabase projects on the newer asymmetric JWT Signing Keys
    feature (ES256 observed in practice) -- SUPABASE_JWT_SECRET is set (it's
    still what flips local verification on) but its value is irrelevant on
    this branch since there's no shared secret to check against, only
    Supabase's published public key."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    token = jwt.encode(
        {"sub": "user-es256", "email": "es@example.com", "aud": "authenticated", "exp": int(time.time()) + 3600},
        private_key,
        algorithm="ES256",
        headers={"kid": "test-kid"},
    )

    class FakeSigningKey:
        key = public_key

    class FakeJWKClient:
        def get_signing_key_from_jwt(self, token):
            return FakeSigningKey()

    monkeypatch.setattr(auth, "_get_jwks_client", lambda: FakeJWKClient())

    user = await auth.get_current_user(authorization=f"Bearer {token}")
    assert user.id == "user-es256"
    assert user.email == "es@example.com"


async def test_falls_back_to_remote_verification_without_secret(monkeypatch, stub_role):
    monkeypatch.setattr(settings, "supabase_jwt_secret", "")

    class FakeUser:
        id = "remote-user"
        email = "remote@example.com"

    class FakeResponse:
        user = FakeUser()

    class FakeAuth:
        def get_user(self, token):
            return FakeResponse()

    class FakeClient:
        auth = FakeAuth()

    monkeypatch.setattr(auth, "get_supabase_client", lambda: FakeClient())

    user = await auth.get_current_user(authorization="Bearer some-opaque-token")
    assert user.id == "remote-user"
    assert user.email == "remote@example.com"
