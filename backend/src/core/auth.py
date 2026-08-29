import logging
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


@dataclass
class CurrentUser:
    id: str
    email: str | None
    role: str = "user"


def _lookup_role(user_id: str) -> str:
    """Fail CLOSED (defaults to "user"), the opposite of usage_events'
    fail-open convention elsewhere in this codebase -- this gates access
    rather than just a usage count, so a missing profiles row or a read
    error must never be treated as admin. See supabase/migrations/0014."""
    try:
        result = get_supabase_client().table("profiles").select("role").eq("user_id", user_id).limit(1).execute()
    except Exception:
        logger.exception("failed to look up role for user=%s", user_id)
        return "user"
    if not result.data:
        return "user"
    return result.data[0]["role"]


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

    return CurrentUser(id=response.user.id, email=response.user.email, role=_lookup_role(response.user.id))


def require_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """Not used by any route yet -- ready for whichever admin-only endpoints
    the future admin app needs. Client-side role checks (the frontend's
    useIsAdmin hook) are NOT a security boundary on their own; any real
    admin endpoint must depend on this instead."""
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user
