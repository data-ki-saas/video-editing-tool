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


class GeneratedAvatarCreateResponse(GeneratedAvatarDetail):
    """The one response that also reports whether a face was actually
    detected in the uploaded photo -- `detected=False` means the returned
    avatar is a generic-toned default, not a personalized one (see
    photo_analysis.py's own fallback contract). Only meaningful right at
    generation time, so this doesn't belong on GeneratedAvatarDetail itself
    (get/list never recompute it)."""

    face_detected: bool
