from pydantic import BaseModel


class GeneratedAvatarSummary(BaseModel):
    id: str
    name: str
    thumbnail_url: str | None
    created_at: str


class GeneratedAvatarDetail(BaseModel):
    """`skin`/`design` are passed straight through as raw dicts already
    shaped like the frontend's AvatarSkin/AvatarDesign (avatar_gen/service.py
    builds them with the exact same camelCase field names) -- this backend
    has no reason to model that schema a second time in Python; compile.ts's
    own validator is the single source of truth for it, same posture as
    avatar/schemas.py's DirectAvatarResponse keeping `params` untyped."""

    id: str
    name: str
    skin: dict
    design: dict
    created_at: str
