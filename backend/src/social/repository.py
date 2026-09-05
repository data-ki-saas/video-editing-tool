from dataclasses import dataclass

from src.core.supabase_client import get_supabase_client

_ACCOUNTS_TABLE = "social_accounts"
_POSTS_TABLE = "social_posts"


@dataclass
class SocialAccountRecord:
    id: str
    user_id: str
    provider: str
    access_token: str
    refresh_token: str
    token_expires_at: str
    account_id: str
    account_name: str
    created_at: str
    updated_at: str


@dataclass
class SocialPostRecord:
    id: str
    library_video_id: str
    user_id: str
    provider: str
    status: str
    provider_video_id: str | None
    provider_url: str | None
    error: str | None
    created_at: str


def get_account(user_id: str, provider: str) -> SocialAccountRecord | None:
    result = (
        get_supabase_client()
        .table(_ACCOUNTS_TABLE)
        .select("*")
        .eq("user_id", user_id)
        .eq("provider", provider)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return SocialAccountRecord(**result.data[0])


def list_accounts(user_id: str) -> list[SocialAccountRecord]:
    result = get_supabase_client().table(_ACCOUNTS_TABLE).select("*").eq("user_id", user_id).execute()
    return [SocialAccountRecord(**row) for row in result.data or []]


def upsert_account(
    *,
    user_id: str,
    provider: str,
    access_token: str,
    refresh_token: str,
    token_expires_at: str,
    account_id: str,
    account_name: str,
) -> SocialAccountRecord:
    payload = {
        "user_id": user_id,
        "provider": provider,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_expires_at": token_expires_at,
        "account_id": account_id,
        "account_name": account_name,
    }
    # on_conflict targets 0025's (user_id, provider) unique constraint --
    # reconnecting the same platform replaces the stored tokens rather than
    # erroring or creating a second row.
    result = get_supabase_client().table(_ACCOUNTS_TABLE).upsert(payload, on_conflict="user_id,provider").execute()
    return SocialAccountRecord(**result.data[0])


def update_tokens(id: str, *, access_token: str, refresh_token: str, token_expires_at: str) -> None:
    get_supabase_client().table(_ACCOUNTS_TABLE).update(
        {"access_token": access_token, "refresh_token": refresh_token, "token_expires_at": token_expires_at}
    ).eq("id", id).execute()


def delete_account(user_id: str, provider: str) -> SocialAccountRecord | None:
    result = (
        get_supabase_client().table(_ACCOUNTS_TABLE).delete().eq("user_id", user_id).eq("provider", provider).execute()
    )
    if not result.data:
        return None
    return SocialAccountRecord(**result.data[0])


def create_post(*, library_video_id: str, user_id: str, provider: str) -> SocialPostRecord:
    payload = {"library_video_id": library_video_id, "user_id": user_id, "provider": provider}
    result = get_supabase_client().table(_POSTS_TABLE).insert(payload).execute()
    return SocialPostRecord(**result.data[0])


def get_post(id: str, user_id: str) -> SocialPostRecord | None:
    result = get_supabase_client().table(_POSTS_TABLE).select("*").eq("id", id).eq("user_id", user_id).limit(1).execute()
    if not result.data:
        return None
    return SocialPostRecord(**result.data[0])


def mark_post_completed(id: str, *, provider_video_id: str, provider_url: str) -> None:
    get_supabase_client().table(_POSTS_TABLE).update(
        {"status": "completed", "provider_video_id": provider_video_id, "provider_url": provider_url}
    ).eq("id", id).execute()


def mark_post_failed(id: str, error: str) -> None:
    get_supabase_client().table(_POSTS_TABLE).update({"status": "failed", "error": error}).eq("id", id).execute()
