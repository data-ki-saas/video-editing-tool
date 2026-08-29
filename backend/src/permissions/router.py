from fastapi import APIRouter, Depends, Query

from src.core.auth import CurrentUser, get_current_user, require_feature
from src.permissions import service
from src.permissions.schemas import (
    AssertFeatureRequest,
    FeatureOut,
    MyPermissionsResponse,
    RoleCreateRequest,
    RoleFeaturesUpdateRequest,
    RoleOut,
    RoleUpdateRequest,
    UserOut,
    UserRoleUpdateRequest,
    UsersListResponse,
)

router = APIRouter(prefix="/api", tags=["permissions"])

# Every admin-facing endpoint below shares this one gate -- there's no
# separate "assign users" permission from "edit role definitions" to keep
# the registry from growing an admin-only sub-hierarchy nobody asked for.
_require_manage_roles = require_feature("admin_manage_roles")


@router.get("/permissions/features", response_model=list[FeatureOut])
async def list_features(user: CurrentUser = Depends(get_current_user)) -> list[FeatureOut]:
    return service.list_features()


@router.get("/permissions/me", response_model=MyPermissionsResponse)
async def my_permissions(user: CurrentUser = Depends(get_current_user)) -> MyPermissionsResponse:
    return service.my_permissions(user.role, user.role_label, user.badge_color, user.features)


@router.post("/permissions/assert", status_code=204)
async def assert_feature(body: AssertFeatureRequest, user: CurrentUser = Depends(get_current_user)) -> None:
    """Called by frontend/src/app/api/render/route.ts (a different runtime,
    same permission source of truth) before it will trigger a Creatomate
    render -- keeps the actual permission logic in one language instead of
    reimplementing it in TypeScript."""
    service.assert_feature(user.role, user.role_label, user.features, body.feature)


@router.get("/roles", response_model=list[RoleOut])
async def list_roles(user: CurrentUser = Depends(_require_manage_roles)) -> list[RoleOut]:
    return service.list_roles()


@router.post("/roles", response_model=RoleOut, status_code=201)
async def create_role(body: RoleCreateRequest, user: CurrentUser = Depends(_require_manage_roles)) -> RoleOut:
    return service.create_role(body)


@router.patch("/roles/{role_key}", response_model=RoleOut)
async def update_role(role_key: str, body: RoleUpdateRequest, user: CurrentUser = Depends(_require_manage_roles)) -> RoleOut:
    return service.update_role(role_key, body)


@router.delete("/roles/{role_key}", status_code=204)
async def delete_role(role_key: str, user: CurrentUser = Depends(_require_manage_roles)) -> None:
    service.delete_role(role_key)


@router.put("/roles/{role_key}/features", response_model=RoleOut)
async def update_role_features(
    role_key: str, body: RoleFeaturesUpdateRequest, user: CurrentUser = Depends(_require_manage_roles)
) -> RoleOut:
    return service.update_role_features(role_key, body, user.role, user.features)


@router.get("/users", response_model=UsersListResponse)
async def list_users(
    search: str | None = Query(default=None), user: CurrentUser = Depends(_require_manage_roles)
) -> UsersListResponse:
    return service.list_users(search)


@router.patch("/users/{user_id}/role", response_model=UserOut)
async def update_user_role(
    user_id: str, body: UserRoleUpdateRequest, user: CurrentUser = Depends(_require_manage_roles)
) -> UserOut:
    return service.update_user_role(user_id, body.role, user.id, user.features)
