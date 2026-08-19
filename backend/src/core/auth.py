from dataclasses import dataclass

from fastapi import Header, HTTPException

from src.core.supabase_client import get_supabase_client


@dataclass
class CurrentUser:
    id: str
    email: str | None


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

    return CurrentUser(id=response.user.id, email=response.user.email)
