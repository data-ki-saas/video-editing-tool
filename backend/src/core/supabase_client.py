from functools import lru_cache

from supabase import Client, create_client

from src.core.config import settings


@lru_cache
def get_supabase_client() -> Client:
    """Backend-privileged client (service role key) — bypasses row-level security.

    Every query in this codebase filters by owner explicitly (via the owning
    project's owner_id), since the service role key does not enforce RLS on
    its own.
    """
    return create_client(settings.supabase_url, settings.supabase_service_role_key)
