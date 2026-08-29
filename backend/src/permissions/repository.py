from src.core.supabase_client import get_supabase_client

_ROLE_SELECT = "key, display_name, description, is_system, is_default, badge_color, role_features(feature_key)"


def _role_row_to_dict(row: dict) -> dict:
    return {
        **{k: v for k, v in row.items() if k != "role_features"},
        "features": [rf["feature_key"] for rf in row["role_features"]],
    }


def get_user_role_and_features(user_id: str) -> tuple[str, str, str, frozenset[str]] | None:
    """One query, embedding profiles -> roles -> role_features via their FKs
    (see 0015) -- same one-query-per-request shape as the pre-RBAC
    _lookup_role. Returns None if the user has no profiles row, so the
    caller can fall back to the default role (0014's "no signup trigger"
    decision means a missing row is normal, not an error)."""
    result = (
        get_supabase_client()
        .table("profiles")
        .select("role, roles(display_name, badge_color, role_features(feature_key))")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not result.data or not result.data[0].get("roles"):
        return None
    row = result.data[0]
    role_obj = row["roles"]
    features = frozenset(rf["feature_key"] for rf in role_obj["role_features"])
    return row["role"], role_obj["display_name"], role_obj["badge_color"], features


def get_default_role_and_features() -> tuple[str, str, str, frozenset[str]]:
    result = (
        get_supabase_client()
        .table("roles")
        .select("key, display_name, badge_color, role_features(feature_key)")
        .eq("is_default", True)
        .limit(1)
        .execute()
    )
    if not result.data:
        return "free_user", "Free", "#64748b", frozenset()
    row = result.data[0]
    return row["key"], row["display_name"], row["badge_color"], frozenset(rf["feature_key"] for rf in row["role_features"])


def list_roles() -> list[dict]:
    result = get_supabase_client().table("roles").select(_ROLE_SELECT).order("created_at").execute()
    return [_role_row_to_dict(row) for row in result.data]


def get_role(role_key: str) -> dict | None:
    result = get_supabase_client().table("roles").select(_ROLE_SELECT).eq("key", role_key).limit(1).execute()
    if not result.data:
        return None
    return _role_row_to_dict(result.data[0])


def count_users_by_role() -> dict[str, int]:
    """No group-by-count in PostgREST without a view/RPC -- fine to count
    client-side at this scale (profiles is one tiny row per signed-up user)."""
    result = get_supabase_client().table("profiles").select("role").execute()
    counts: dict[str, int] = {}
    for row in result.data:
        counts[row["role"]] = counts.get(row["role"], 0) + 1
    return counts


def create_role(*, key: str, display_name: str, description: str | None, badge_color: str) -> None:
    get_supabase_client().table("roles").insert(
        {"key": key, "display_name": display_name, "description": description, "badge_color": badge_color}
    ).execute()


def update_role(role_key: str, **fields) -> None:
    get_supabase_client().table("roles").update(fields).eq("key", role_key).execute()


def delete_role(role_key: str) -> None:
    # role_features rows for this role are removed via "on delete cascade".
    get_supabase_client().table("roles").delete().eq("key", role_key).execute()


def set_role_features(role_key: str, feature_keys: list[str]) -> None:
    client = get_supabase_client()
    client.table("role_features").delete().eq("role_key", role_key).execute()
    if feature_keys:
        client.table("role_features").insert(
            [{"role_key": role_key, "feature_key": key} for key in feature_keys]
        ).execute()


def count_roles_granting(feature_key: str) -> int:
    result = (
        get_supabase_client()
        .table("role_features")
        .select("role_key", count="exact")
        .eq("feature_key", feature_key)
        .execute()
    )
    return result.count or 0


def list_users(search: str | None) -> list[dict]:
    """public.users is the source of truth for "who has signed up" (see
    0001's handle_new_user trigger) -- a left-embed of profiles(role) so a
    user with no profiles row yet still shows up (resolved to the default
    role by the service layer), which is exactly the case an admin needs
    this search for: assigning a first-ever role to a brand new signup."""
    query = get_supabase_client().table("users").select("id, email, display_name, profiles(role)")
    if search:
        query = query.ilike("email", f"%{search}%")
    result = query.order("email").limit(50).execute()
    return result.data


def get_user_basic(user_id: str) -> dict | None:
    result = get_supabase_client().table("users").select("id, email, display_name").eq("id", user_id).limit(1).execute()
    return result.data[0] if result.data else None


def upsert_user_role(user_id: str, role_key: str) -> None:
    get_supabase_client().table("profiles").upsert({"user_id": user_id, "role": role_key}).execute()
