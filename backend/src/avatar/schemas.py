from pydantic import BaseModel


class LockedBeat(BaseModel):
    """One tag-derived beat (avatar/tags.ts on the frontend) the "direct"
    LLM must not propose an overlapping beat over, in the SAME layer --
    an explicit `{angry}`/`{wave}` in the script is a more direct
    instruction than whatever the LLM would otherwise fill that stretch
    with. `beat_id` is just for the LLM's own reference in its response
    (unused by parsing) -- the ranges themselves are what's enforced."""

    layer: str  # "gesture" | "gaze" | "mood"
    beat_id: str
    start_ms: int
    end_ms: int


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
    # Layered motion -- same per-Topology-capability principle as action_ids
    # above, for this avatar's own gesture/gaze/mood vocabulary (topology.ts's
    # gestures/gazes/moodPresets). Empty lists (the default) mean this avatar
    # has none -- the LLM is simply never offered those ops.
    gesture_ids: list[str] = []
    gaze_ids: list[str] = []
    mood_ids: list[str] = []
    # Tag-derived beats already committed on the narration script -- see
    # LockedBeat's own doc comment.
    locked_beats: list[LockedBeat] = []


class AvatarActionBeat(BaseModel):
    action: str
    start_ms: int
    end_ms: int
    params: dict[str, float] | None = None


class GestureBeat(BaseModel):
    gesture_id: str
    start_ms: int
    end_ms: int


class GazeBeat(BaseModel):
    gaze_id: str
    start_ms: int
    end_ms: int


class MoodBeat(BaseModel):
    mood_id: str
    start_ms: int
    end_ms: int


class DirectAvatarResponse(BaseModel):
    action_timeline: list[AvatarActionBeat]
    # Layered motion -- filled in ONLY for stretches of the script the
    # locked_beats above don't already cover (see service.py's own
    # _edit_system_prompt-style instruction to the LLM). Empty when this
    # avatar has no gesture/gaze/mood vocabulary at all.
    gesture_timeline: list[GestureBeat] = []
    gaze_timeline: list[GazeBeat] = []
    mood_timeline: list[MoodBeat] = []
    # One short, plain-language line explaining the overall direction chosen
    # -- surfaced in AvatarFramingDialog so the choice isn't a black box (see
    # the plan's "Director's notes" idea). Never persisted on the clip;
    # shown once, right after generating.
    director_note: str | None = None


class AvatarEditAccessoryOption(BaseModel):
    """One catalog entry (frontend/src/lib/video/avatar/accessories.ts) this
    SPECIFIC avatar's topology can actually accept -- already filtered by the
    frontend to only anchors this avatar's own topology declares, same
    per-Topology-capability read-at-request-time principle DirectAvatarRequest's
    own `action_ids` already follows."""

    accessory_asset_id: str
    anchor_id: str
    name: str


class EditAvatarRequest(BaseModel):
    """Phase 7 -- conversational Design edits. Every id list below is THIS
    avatar's own resolved capability set (its topology's boneGroups/anchors,
    its skin's colorSlots, its topology's expressionParams), read at request
    time by the frontend (AvatarFramingDialog) -- never a hardcoded global
    vocabulary, so the ops this endpoint may propose always match what the
    picked character can actually do."""

    prompt: str
    bone_group_ids: list[str]
    color_slot_ids: list[str]
    accessories: list[AvatarEditAccessoryOption]
    # paramId -> [min, max] -- expression_params.py's own ExpressionParamSpec
    # (topology.ts) carries a `default` too, but only the bounds matter for
    # clamping a proposed value here.
    expression_params: dict[str, list[float]]
    # This avatar's own resolved action ids (actionIdsForAvatar) and garment
    # shape ids (skin.garmentShapes, "shirt" standing in for the base torso
    # with no garmentId -- see AvatarFramingDialog's garmentOptions) -- folded
    # in so a single prompt can also direct the clip's action/framing/outfit,
    # same per-Topology-capability principle as every other list here.
    action_ids: list[str]
    garment_ids: list[str]


class AvatarEditOp(BaseModel):
    """One primitive edit op -- a flat, all-fields-optional shape covering
    all eight ops in the closed vocabulary (setBoneScale/setColorSlot/
    addAccessory/removeAccessory/setExpression/setGarment/setAction/
    setFraming), same untyped-per-op-shape posture as AvatarActionBeat.params
    above (avatar/edits.ts on the frontend is the single source of truth for
    which fields a given `op` actually needs; this model only needs to ferry
    them across the wire, and re-parses/re-validates every field defensively
    there too)."""

    op: str
    group_id: str | None = None
    slot_id: str | None = None
    anchor_id: str | None = None
    accessory_asset_id: str | None = None
    color: str | None = None
    color_override: str | None = None
    param_id: str | None = None
    value: float | None = None
    garment_id: str | None = None
    action_id: str | None = None
    framing: str | None = None


class EditAvatarResponse(BaseModel):
    ops: list[AvatarEditOp]


class ResolveAvatarTagRequest(BaseModel):
    """A `{freeword}` script tag (avatar/tags.ts) that didn't match this
    avatar's own closed gesture/gaze/mood vocabulary -- asks the LLM to map
    it to the single closest known id, or say nothing's close enough."""

    free_text: str
    gesture_ids: list[str]
    gaze_ids: list[str]
    mood_ids: list[str]


class ResolveAvatarTagResponse(BaseModel):
    # Both null together means "no good match" -- the frontend then just
    # drops the tag rather than guessing.
    layer: str | None = None  # "gesture" | "gaze" | "mood"
    id: str | None = None
