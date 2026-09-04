import logging
import time
from dataclasses import dataclass

import jwt
from fastapi import Depends, Header, HTTPException

from src.core.config import settings
from src.core.supabase_client import get_supabase_client
from src.permissions import repository as permissions_repository
from src.permissions.service import feature_denied_detail

logger = logging.getLogger(__name__)

# Lazily created, then reused for the life of the process -- PyJWKClient
# caches the fetched key set in-memory internally, so this only round-trips
# to Supabase's JWKS endpoint once per (rare) key rotation, not per request.
_jwks_client: jwt.PyJWKClient | None = None


def _get_jwks_client() -> jwt.PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = jwt.PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json", cache_keys=True)
    return _jwks_client


@dataclass
class CurrentUser:
    id: str
    email: str | None
    role: str = "free_user"
    role_label: str = "Free"
    badge_color: str = "#64748b"
    features: frozenset[str] = frozenset()


def _lookup_role(user_id: str) -> tuple[str, str, str, frozenset[str]]:
    """Fail CLOSED -- any missing profiles row or read error resolves to
    the default role's own (never-privileged-by-design) feature set, the
    opposite of usage_events' fail-open convention elsewhere in this
    codebase, since this gates access rather than just a usage count. See
    supabase/migrations/0014 and 0015."""
    try:
        result = permissions_repository.get_user_role_and_features(user_id)
        if result is not None:
            return result
        return permissions_repository.get_default_role_and_features()
    except Exception:
        logger.exception("failed to look up role for user=%s", user_id)
        return "free_user", "Free", "#64748b", frozenset()


def _verify_token(token: str) -> tuple[str, str | None]:
    """Returns (user_id, email) for a valid access token.

    Verifies locally (no network call for HS256; one cached JWKS fetch per
    key rotation for asymmetric algorithms) when SUPABASE_JWT_SECRET is
    configured; falls back to the slower auth.get_user() round trip to
    Supabase Auth otherwise, so this degrades gracefully on a deploy that
    hasn't set the new env var yet (see DEPLOY.md).

    Supabase projects sign access tokens either with a shared HS256 secret
    (the dashboard's "Legacy JWT Secret") or, on projects that have adopted
    Supabase's JWT Signing Keys feature, an asymmetric key (ES256 seen in
    practice; RS256/EdDSA are the other Supabase-supported options) -- there
    is no shared secret at all in that case, only a public verification key
    Supabase publishes at /auth/v1/.well-known/jwks.json. The token header's
    own "alg" says which one applies, so branch on that rather than assuming
    HS256 -- an asymmetric project's tokens will never verify against
    SUPABASE_JWT_SECRET no matter how correctly that value is copied.
    SUPABASE_JWT_SECRET being set is still what turns local verification on
    at all (its value is simply unused on the JWKS branch); leaving it unset
    always takes the remote auth.get_user() path below regardless of algorithm.

    Trade-off: local verification only checks the token's signature and
    expiry, not live revocation -- a token for a user banned or deleted after
    it was issued still passes here until it naturally expires (Supabase
    access tokens default to a 1-hour lifetime). auth.get_user() catches that
    immediately since it asks Supabase directly. Same trade-off any
    JWT-verified-locally backend accepts in exchange for not paying a network
    round trip per request.
    """
    if settings.supabase_jwt_secret:
        alg = "HS256"
        try:
            alg = jwt.get_unverified_header(token).get("alg", "HS256")
            if alg == "HS256":
                key = settings.supabase_jwt_secret
            else:
                key = _get_jwks_client().get_signing_key_from_jwt(token).key
            claims = jwt.decode(token, key, algorithms=[alg], audience="authenticated")
        except jwt.InvalidSignatureError as exc:
            # Every token signature failing (as opposed to occasional
            # ExpiredSignatureError from normal token aging) means either
            # SUPABASE_JWT_SECRET is stale (rotated in Supabase without
            # updating this deploy's env var -- only possible on the HS256
            # branch) or, on the JWKS branch, that something is verifying
            # against the wrong Supabase project. Logged distinctly so this
            # shows up as a config problem in Render logs rather than
            # looking like a wave of individually bad tokens.
            logger.warning(
                "JWT signature verification failed (alg=%s) -- if HS256, SUPABASE_JWT_SECRET "
                "is likely stale (rotated in Supabase?); re-copy it from Supabase Settings > "
                "API > JWT Settings. If not HS256, double check SUPABASE_URL points at the "
                "right project",
                alg,
            )
            raise HTTPException(status_code=401, detail="Invalid or expired token") from exc
        except jwt.PyJWTError as exc:
            raise HTTPException(status_code=401, detail="Invalid or expired token") from exc
        return claims["sub"], claims.get("email")

    try:
        response = get_supabase_client().auth.get_user(token)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc
    if response is None or response.user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return response.user.id, response.user.email


# Per-process, per-token cache so the handful of requests a single page load
# fires (permissions/me, then that page's own data calls) don't each re-pay
# _verify_token + _lookup_role from scratch -- see the admin pages' own
# waterfall this was written to fix. Short enough that a role change made in
# /admin/users reaches that user's next few requests almost immediately.
_CACHE_TTL_SECONDS = 30
_user_cache: dict[str, tuple[float, "CurrentUser"]] = {}


def _cache_get(token: str) -> "CurrentUser | None":
    entry = _user_cache.get(token)
    if entry is None:
        return None
    expires_at, user = entry
    if expires_at <= time.monotonic():
        del _user_cache[token]
        return None
    return user


def _cache_set(token: str, user: "CurrentUser") -> None:
    now = time.monotonic()
    expired = [t for t, (expires_at, _) in _user_cache.items() if expires_at <= now]
    for t in expired:
        del _user_cache[t]
    _user_cache[token] = (now + _CACHE_TTL_SECONDS, user)


async def get_current_user(authorization: str = Header(default="")) -> CurrentUser:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = authorization[len("bearer ") :].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")

    cached = _cache_get(token)
    if cached is not None:
        return cached

    user_id, email = _verify_token(token)
    role, role_label, badge_color, features = _lookup_role(user_id)
    user = CurrentUser(id=user_id, email=email, role=role, role_label=role_label, badge_color=badge_color, features=features)
    _cache_set(token, user)
    return user


def require_feature(feature_key: str):
    """Dependency factory: Depends(require_feature("tts_synthesize")) 403s
    with a structured "upgrade" body (see permissions/service.py's
    feature_denied_detail) if the caller's role doesn't grant feature_key.
    Client-side permission checks (the frontend's usePermissions hook) are
    NOT a security boundary on their own; any real gated endpoint must
    depend on this instead."""

    def _dependency(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if feature_key not in user.features:
            raise HTTPException(status_code=403, detail=feature_denied_detail(user.role, user.role_label, feature_key))
        return user

    return _dependency


# Back-compat name for the single feature every seeded role's admin-only
# capability boils down to -- see permissions/features.py.
require_admin = require_feature("admin_manage_roles")


def bypasses_daily_caps(user: CurrentUser) -> bool:
    """Admin accounts skip every daily usage-cap guardrail (TTS/avatar/
    matting/render -- see tts/service.py, avatar/service.py,
    matting/service.py, and usage/service.py's assert_render_cap), so an
    admin testing or demoing the product never gets stopped by an
    abuse-rate-limit meant for regular accounts. Reuses admin_manage_roles
    (the same feature require_admin gates on) rather than a dedicated
    feature key -- deliberately tied to full admin, not a lesser role, since
    bypassing a cost/abuse guardrail is exactly that sensitive."""
    return "admin_manage_roles" in user.features
