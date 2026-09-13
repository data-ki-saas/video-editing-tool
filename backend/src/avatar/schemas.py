from pydantic import BaseModel


class DirectAvatarRequest(BaseModel):
    script: str
    narration_duration_seconds: float
    # The picked avatar's OWN resolved topology action ids (baseline six plus
    # whatever extras that topology declares) -- read at request time from
    # the frontend's own actionIdsForAvatar, never a hardcoded list here, so
    # the director's vocabulary always matches what this specific character
    # can actually do (see the Avatar Design plan's "per-Topology
    # capability, not one global enum" note).
    action_ids: list[str]


class AvatarActionBeat(BaseModel):
    action: str
    start_ms: int
    end_ms: int
    params: dict[str, float] | None = None


class DirectAvatarResponse(BaseModel):
    action_timeline: list[AvatarActionBeat]
    # One short, plain-language line explaining the overall direction chosen
    # -- surfaced in AvatarFramingDialog so the choice isn't a black box (see
    # the plan's "Director's notes" idea). Never persisted on the clip;
    # shown once, right after generating.
    director_note: str | None = None
