from pydantic import BaseModel


class FeatureOut(BaseModel):
    key: str
    label: str
    group: str


class RoleOut(BaseModel):
    key: str
    display_name: str
    description: str | None
    is_system: bool
    is_default: bool
    badge_color: str
    user_count: int
    features: list[str]


class RoleCreateRequest(BaseModel):
    key: str
    display_name: str
    description: str | None = None
    badge_color: str = "#64748b"


class RoleUpdateRequest(BaseModel):
    display_name: str | None = None
    description: str | None = None
    badge_color: str | None = None


class RoleFeaturesUpdateRequest(BaseModel):
    features: list[str]


class AssertFeatureRequest(BaseModel):
    feature: str


class MyPermissionsResponse(BaseModel):
    role: str
    role_label: str
    badge_color: str
    features: list[str]


class UserOut(BaseModel):
    id: str
    email: str | None
    display_name: str | None
    role: str
    role_label: str
    badge_color: str


class UsersListResponse(BaseModel):
    users: list[UserOut]


class UserRoleUpdateRequest(BaseModel):
    role: str
