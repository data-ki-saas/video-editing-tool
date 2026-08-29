import logging
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException

from src.core.supabase_client import get_supabase_client
from src.permissions import repository as permissions_repository
from src.permissions.service import feature_denied_detail

logger = logging.getLogger(__name__)


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


async def get_current_user(authorization: str = Header(default="")) -> CurrentUser:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = authorization[len("bearer ") :].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")

    try:
        response = get_supabase_client().auth.get_user(token)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc

    if response is None or response.user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    role, role_label, badge_color, features = _lookup_role(response.user.id)
    return CurrentUser(
        id=response.user.id,
        email=response.user.email,
        role=role,
        role_label=role_label,
        badge_color=badge_color,
        features=features,
    )


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
