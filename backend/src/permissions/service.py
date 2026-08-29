import re

from fastapi import HTTPException

from src.permissions import repository
from src.permissions.features import FEATURES, FEATURE_KEYS, label_for
from src.permissions.schemas import (
    FeatureOut,
    MyPermissionsResponse,
    RoleCreateRequest,
    RoleFeaturesUpdateRequest,
    RoleOut,
    RoleUpdateRequest,
    UserOut,
    UsersListResponse,
)

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,49}$")

# NOTE: this module must never import src.core.auth -- auth.py imports
# feature_denied_detail from here to build require_feature()'s 403 body, so
# an import back the other way would be a cycle. Every function here takes
# plain role/feature strings, never a CurrentUser, for that reason.


def feature_denied_detail(role: str, role_label: str, feature_key: str) -> dict:
    label = label_for(feature_key)
    return {
        "code": "feature_not_allowed",
        "feature": feature_key,
        "feature_label": label,
        "role": role,
        "role_label": role_label,
        "message": f"{label} isn't included in your {role_label} plan.",
        "upgrade_url": "/pricing",
    }


def list_features() -> list[FeatureOut]:
    return [FeatureOut(key=f.key, label=f.label, group=f.group) for f in FEATURES]


def my_permissions(role: str, role_label: str, badge_color: str, features: frozenset[str]) -> MyPermissionsResponse:
    return MyPermissionsResponse(role=role, role_label=role_label, badge_color=badge_color, features=sorted(features))


def assert_feature(role: str, role_label: str, features: frozenset[str], feature_key: str) -> None:
    if feature_key not in FEATURE_KEYS:
        raise HTTPException(status_code=400, detail=f"Unknown feature '{feature_key}'")
    if feature_key not in features:
        raise HTTPException(status_code=403, detail=feature_denied_detail(role, role_label, feature_key))


def _role_out(row: dict, counts: dict[str, int]) -> RoleOut:
    return RoleOut(
        key=row["key"],
        display_name=row["display_name"],
        description=row["description"],
        is_system=row["is_system"],
        is_default=row["is_default"],
        badge_color=row["badge_color"],
        user_count=counts.get(row["key"], 0),
        features=row["features"],
    )


def _role_out_by_key(role_key: str) -> RoleOut:
    row = repository.get_role(role_key)
    if row is None:
        raise HTTPException(status_code=404, detail="Role not found")
    return _role_out(row, repository.count_users_by_role())


def list_roles() -> list[RoleOut]:
    counts = repository.count_users_by_role()
    return [_role_out(row, counts) for row in repository.list_roles()]


def create_role(body: RoleCreateRequest) -> RoleOut:
    if not _KEY_RE.match(body.key):
        raise HTTPException(status_code=400, detail="Role key must start with a letter and contain only lowercase letters, numbers, and underscores")
    if repository.get_role(body.key) is not None:
        raise HTTPException(status_code=409, detail="A role with this key already exists")
    repository.create_role(key=body.key, display_name=body.display_name, description=body.description, badge_color=body.badge_color)
    return _role_out_by_key(body.key)


def update_role(role_key: str, body: RoleUpdateRequest) -> RoleOut:
    if repository.get_role(role_key) is None:
        raise HTTPException(status_code=404, detail="Role not found")
    fields = body.model_dump(exclude_unset=True)
    if fields:
        repository.update_role(role_key, **fields)
    return _role_out_by_key(role_key)


def delete_role(role_key: str) -> None:
    row = repository.get_role(role_key)
    if row is None:
        raise HTTPException(status_code=404, detail="Role not found")
    if row["is_system"]:
        raise HTTPException(status_code=409, detail={"code": "role_is_system", "message": "This role can't be deleted."})
    user_count = repository.count_users_by_role().get(role_key, 0)
    if user_count > 0:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "role_has_users",
                "user_count": user_count,
                "message": f"{user_count} user(s) still have this role -- reassign them first.",
            },
        )
    repository.delete_role(role_key)


def update_role_features(
    role_key: str, body: RoleFeaturesUpdateRequest, caller_role: str, caller_features: frozenset[str]
) -> RoleOut:
    row = repository.get_role(role_key)
    if row is None:
        raise HTTPException(status_code=404, detail="Role not found")
    unknown = set(body.features) - FEATURE_KEYS
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown feature key(s): {', '.join(sorted(unknown))}")

    removing_admin_manage = "admin_manage_roles" in row["features"] and "admin_manage_roles" not in body.features
    if removing_admin_manage:
        # Two distinct lockout guards: never let the caller strip their OWN
        # current role's admin access (even if another role also grants it --
        # simplest rule to reason about, no risk of a mid-session surprise),
        # and never let the last role holding admin_manage_roles lose it.
        if role_key == caller_role and "admin_manage_roles" in caller_features:
            raise HTTPException(status_code=409, detail="You can't remove admin_manage_roles from your own current role.")
        if repository.count_roles_granting("admin_manage_roles") <= 1:
            raise HTTPException(status_code=409, detail="At least one role must be able to manage roles.")

    repository.set_role_features(role_key, body.features)
    return _role_out_by_key(role_key)


def list_users(search: str | None) -> UsersListResponse:
    roles_index = {row["key"]: row for row in repository.list_roles()}
    default_key = next((key for key, row in roles_index.items() if row["is_default"]), "free_user")
    users = []
    for row in repository.list_users(search):
        profile = row.get("profiles")
        role_key = profile["role"] if profile else default_key
        role_row = roles_index.get(role_key, {})
        users.append(
            UserOut(
                id=row["id"],
                email=row.get("email"),
                display_name=row.get("display_name"),
                role=role_key,
                role_label=role_row.get("display_name", role_key),
                badge_color=role_row.get("badge_color", "#64748b"),
            )
        )
    return UsersListResponse(users=users)


def update_user_role(user_id: str, new_role_key: str, caller_id: str, caller_features: frozenset[str]) -> UserOut:
    new_role = repository.get_role(new_role_key)
    if new_role is None:
        raise HTTPException(status_code=404, detail="Role not found")
    if user_id == caller_id and "admin_manage_roles" in caller_features and "admin_manage_roles" not in new_role["features"]:
        raise HTTPException(status_code=409, detail="You can't remove your own admin access.")

    repository.upsert_user_role(user_id, new_role_key)

    user_row = repository.get_user_basic(user_id) or {}
    return UserOut(
        id=user_id,
        email=user_row.get("email"),
        display_name=user_row.get("display_name"),
        role=new_role_key,
        role_label=new_role["display_name"],
        badge_color=new_role["badge_color"],
    )
