/**
 * The shared "skeleton" layer of the Avatar animation engine -- see this
 * feature's own plan doc (golden-herding-yeti.md) for the full Topology/
 * Skin/Design split; this file is only the Topology third. A Topology is
 * engineered rarely (a handful of these will ever exist across the whole
 * library) and owns everything that's really about the RIG rather than any
 * one character's look: bone hierarchy, rest pose, and action curves. Many
 * Skins (skin.ts) bind to one Topology and inherit its walk cycle/idle sway
 * for free -- that reuse is the entire point of not flattening this into one
 * per-character document.
 *
 * Same "pure function of elapsed time" discipline as ambientEffects.ts and
 * camera3D.ts governs everything downstream of this file (see actions.ts) --
 * a Topology itself is just data, but it's authored with that discipline in
 * mind: every `ActionCurveSpec` here is a closed loop over `periodSeconds`,
 * nothing time-of-day or random baked in (`lookAround`'s seeded randomness
 * lives entirely in actions.ts's evaluator, keyed off a caller-supplied
 * `seed` + `elapsedSeconds` -- never off anything read at authoring time).
 */

/**
 * The baseline action set every Topology must provide a curve for (see
 * library.ts's `biped-simple`, which defines all six) -- mirrors this
 * product's actual avatar-overlay UI (a fixed picker of these six states).
 * A Topology MAY declare additional, non-baseline action ids beyond this
 * union (a future "wave"/"dance"/"point") -- that's exactly why
 * `AvatarTopology.actions` below is typed as this union PLUS an open string
 * index, not a closed `Record<AvatarActionId, ...>`.
 */
export type AvatarActionId = "idle" | "talk" | "walk" | "sit" | "sleep" | "lookAround";

/**
 * The layered-motion redesign's own closed vocabularies -- unlike
 * `AvatarActionId` (a whole-body posture, one at a time), a gesture/gaze
 * plays on top of whichever posture action is already active, scoped to a
 * narrow bone group (arms / head respectively -- see `AvatarTopology.gestures`/
 * `gazes` below), and a mood is a named preset over this topology's own
 * `expressionParams` rather than a bone curve at all (see `moodPresets`).
 * Each is an open string index PLUS this union for the same reason
 * `AvatarActionId` is: a richer topology may declare extras beyond the
 * baseline set.
 */
export type AvatarGestureId =
  | "wave"
  | "point"
  | "pointLeft"
  | "pointRight"
  | "shrug"
  | "openArms"
  | "fistThump"
  | "facepalm"
  | "hitLeft"
  | "hitRight";
export type AvatarGazeId = "lookLeft" | "lookRight" | "lookAtCamera" | "lookDown";
export type AvatarMoodId = "angry" | "happy" | "sad" | "evil" | "calm" | "excited" | "scared";

/**
 * A bone's local transform relative to its PARENT bone (or, for the root
 * bone, relative to the rig's own origin) -- x/y are translation, not
 * pixels, but rig-space units (see AvatarTopology.rigWidth/rigHeight): the
 * renderer (renderer.ts) is what scales rig-space into whatever pixel-sized
 * destRect a clip actually occupies, so nothing in the rig itself needs to
 * know or care about final on-screen size. `rotation` is radians (renderer.ts
 * converts to degrees only at the one call site DOMMatrix.rotate needs it).
 */
export interface BoneTransform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/**
 * One sparse sample of an action's per-bone motion at a fraction `t` (0..1)
 * of the action's own `periodSeconds` loop. `delta` is NOT a full pose --
 * it's an offset layered on top of `defaultLocalPose[boneIndex]`, and the two
 * numeric fields groups combine DIFFERENTLY:
 *  - x/y/rotation are ADDITIVE (delta 0 = "no change from rest").
 *  - scaleX/scaleY are MULTIPLICATIVE against the default (delta 1 = "no
 *    change from rest"; a delta of 1.1 means "10% bigger than whatever this
 *    bone's own rest scale already is", NOT "absolute scale 1.1" -- easy to
 *    get backwards when hand-authoring a curve, called out here deliberately
 *    since nothing about the field name alone signals which convention
 *    applies).
 * Any field left out of `delta` means "no change on that field" under its
 * OWN rule above (0 for x/y/rotation, 1 for scaleX/scaleY) -- see actions.ts's
 * `resolvedDelta` for where that fill-in actually happens.
 */
export interface ActionKeyframe {
  t: number;
  boneIndex: number;
  delta: Partial<BoneTransform>;
}

/**
 * One action's full looping motion, as a sparse set of per-bone keyframes
 * rather than a dense per-frame recording -- `actions.ts`'s evaluator
 * reconstructs the pose at any `elapsedSeconds` by wrapping
 * `elapsedSeconds % periodSeconds` into a 0..1 phase and, independently for
 * each bone, linearly interpolating between whichever two of THAT bone's own
 * keyframes straddle the current phase (wrapping across the t=1/t=0 seam, so
 * the loop has no seam-frame jump). A bone with only one keyframe holds that
 * delta constant for the whole loop (a deliberate shorthand for "this bone
 * doesn't move in this action" without needing to duplicate the same
 * keyframe twice); a bone with none stays at its plain rest pose.
 *
 * `usesSeed` is a marker consumed only by actions.ts's special-cased
 * `lookAround` evaluator (true for that action only) -- see this file's own
 * `AvatarTopology.actions` doc for the unusual convention `lookAround`'s own
 * single keyframe is used for.
 *
 * `loop` (default true, i.e. every spec authored before the layered-motion
 * redesign is unaffected) -- `false` means "play through ONCE": the evaluator
 * clamps `elapsedSeconds / periodSeconds` to [0,1] instead of wrapping it, so
 * the curve holds at its own t=1 keyframe once played rather than restarting.
 * Every gesture/gaze spec (`AvatarTopology.gestures`/`gazes`) should set this
 * false and author its own t=0/t=1 keyframes back at identity, so a one-shot
 * gesture always returns cleanly to rest (or to whatever the posture layer
 * underneath it is doing) once its own short duration elapses.
 */
export interface ActionCurveSpec {
  periodSeconds: number;
  keyframes: ActionKeyframe[];
  usesSeed?: boolean;
  loop?: boolean;
}

/**
 * A named attachment point for a FUTURE phase's props/accessories (a hat at
 * "head", a held prop at "handL"/"handR") -- nothing in this phase reads
 * these yet, but they're cheap to author now and awkward to retrofit onto an
 * already-shipped Topology later, so the seed rig (library.ts) populates a
 * real set. `localOffset` is in the same rig-space units as BoneTransform,
 * measured from the named bone's own local origin.
 */
export interface AvatarAnchor {
  anchorId: string;
  boneIndex: number;
  localOffset: { x: number; y: number };
}

/**
 * One bone's contribution to an expression param at that param's value ==
 * `spec.max` (or, symmetrically, `spec.min` on the negative side -- see
 * ExpressionParamSpec's own doc comment for how the two directions share this
 * single delta). Same additive-x/y/rotation, multiplicative-scale rule as
 * ActionKeyframe's own delta (topology.ts's own convention) -- NOT a
 * separate rule invented for expressions.
 */
export interface ExpressionBoneDelta {
  boneIndex: number;
  delta: Partial<BoneTransform>;
}

/**
 * One color slot's contribution to an expression param -- unlike
 * ExpressionBoneDelta above, color needs a DIFFERENT target at each end of
 * the range rather than one delta mirrored by sign (there's no natural
 * "negative color"), so this names both ends explicitly. actions.ts/
 * compile.ts blend the slot's current color toward whichever end the bias is
 * closer to, in proportion to how far it's pushed toward that end.
 */
export interface ExpressionColorDelta {
  slotId: string;
  towardColorAtMax: string;
  towardColorAtMin: string;
}

/**
 * One named, bounded "mood" slider (Phase 7 -- conversational Design edits):
 * `min`/`max`/`default` bound whatever value a Design's own `expressionBias`
 * (design.ts) may hold for this paramId, and `boneDeltas`/`colorDeltas`
 * describe what moving the slider actually DOES. A param may declare either,
 * both, or neither (a param with only `colorDeltas` moves no bone at all,
 * e.g. a pure "mood color" slider). Compiled/applied by compile.ts
 * (colorDeltas, resolved once at compile time into a recolored atlas) and
 * actions.ts (boneDeltas, resolved every frame alongside the active action's
 * own pose, same as any other additive bone delta).
 */
export interface ExpressionParamSpec {
  min: number;
  max: number;
  default: number;
  boneDeltas?: ExpressionBoneDelta[];
  colorDeltas?: ExpressionColorDelta[];
}

/**
 * Phase 8 ("Portrait mode") -- what an AvatarOverlayClip's `framing: "bust"`
 * (video_math.ts) actually does to THIS topology's rig: which bones to skip
 * drawing entirely (renderer.ts's drawAvatar), and what rig-space height to
 * fit-by-height against instead of the full `rigHeight` (so the torso/arms/
 * head fill the box the same way the full rig fills it in "full" framing,
 * rather than shrinking to leave dead space where the legs used to be).
 * Optional on AvatarTopology -- a topology that never defines this (a future
 * half-body-only rig, or one authored before this phase) just has "bust"
 * framing silently behave identically to "full" (see renderer.ts's own
 * fallback), rather than every topology being forced to declare it.
 */
export interface AvatarBustFraming {
  hiddenBoneIndices: number[];
  frameHeight: number;
}

/**
 * The shared skeleton + action library one or more Skins bind to. This is
 * the ONE layer of the three (Topology/Skin/Design) that owns bone-driven
 * animation logic -- action curves, scalable bone groupings, attachment
 * anchors, and (Phase 7) expression params.
 */
export interface AvatarTopology {
  schemaVersion: 1;
  topologyId: string;

  // The virtual authoring canvas every bone position and (in skin.ts) every
  // part's pixel rect is defined against -- NOT the pixel size of any
  // particular clip's destRect. renderer.ts fits this rig into whatever
  // destRect a clip actually has by scaling to destRect's HEIGHT (a
  // bust-framed portrait character has room to spare on the sides in a wider
  // box; see renderer.ts's own comment) -- so this pair only needs to capture
  // the rig's own aspect ratio and a comfortable working resolution, never a
  // real output size. Portrait-ish by convention, matching this product's
  // primary reel framing.
  rigWidth: number;
  rigHeight: number;

  boneNames: string[];

  // parentIndex[i] is bone i's parent's index, or -1 for the root. MUST
  // satisfy parentIndex[i] < i for every i > 0 -- i.e. authored so a parent
  // always appears earlier in the array than its children. This isn't just a
  // style convention: it's what lets both compile.ts's validation and
  // renderer.ts's per-frame forward-kinematics pass be a single linear walk
  // (bone i's world matrix is always buildable the moment bone i is reached,
  // since its parent's world matrix was already computed on an earlier
  // iteration) with no separate topological sort. compile.ts asserts this at
  // load time and throws rather than letting a malformed rig silently
  // mis-render.
  parentIndex: number[];

  // The rest pose -- index-ordered, same length/order as boneNames. Every
  // action's keyframe `delta` (see ActionKeyframe) is layered on top of this,
  // never a replacement for it.
  defaultLocalPose: BoneTransform[];

  // Named regions (e.g. "torso", "limbs") for a FUTURE uniform-scale
  // "make it fatter/taller" style edit to target -- NOT consumed by
  // anything in this phase (that later edit would write a multiplier into
  // AvatarDesign.boneScaleOverrides, keyed by these same group ids, for
  // compile.ts to apply -- but compile.ts in this phase does not read
  // boneScaleOverrides at all yet). Declared now so the schema doesn't need
  // a breaking change once that edit ships. Every seed Topology should still
  // populate at least one real, sensible grouping (see library.ts) even
  // though nothing reads it today.
  boneGroups: Record<string, number[]>;

  // Attachment points for a future accessories/props phase -- see
  // AvatarAnchor's own doc comment. NOT consumed by anything in this phase.
  anchors: AvatarAnchor[];

  // The six baseline ids (AvatarActionId) are each OPTIONAL here at the type
  // level (a Topology could in principle omit one, though every real seed
  // Topology should define all six -- see library.ts), but a Topology may
  // ALSO declare arbitrary extra action ids beyond that baseline (a future
  // "wave", "dance", "point", ...) -- hence the open string index alongside
  // the specific union, rather than a closed Record<AvatarActionId, ...>.
  actions: Partial<Record<AvatarActionId, ActionCurveSpec>> & Record<string, ActionCurveSpec>;

  // Phase 7: a handful of named, bounded "mood" sliders a Design's own
  // `expressionBias` (design.ts) holds current values for -- e.g.
  // "browAngle"/"energy"/"colorMood" on biped-simple (see library.ts). Optional
  // and possibly entirely absent (a topology need not offer any expression
  // params at all); every consumer (actions.ts, compile.ts, this feature's
  // edit-ops validator) already treats a missing/empty map as "no expression
  // capability for this avatar" rather than erroring.
  expressionParams?: Record<string, ExpressionParamSpec>;

  // Phase 8 -- see AvatarBustFraming's own doc comment above.
  bustFraming?: AvatarBustFraming;

  // Layered motion -- a gesture/gaze plays ON TOP of whichever posture action
  // (`actions` above) is currently active: actions.ts's computeLayeredAvatarPose
  // computes the posture pose first, then, for whichever of these is
  // currently active, REPLACES (never adds to) that pose's own value for
  // every bone the active spec's keyframes name -- so a gesture's arm
  // keyframes should scope to `boneGroups.arms`' bone indices only, and a
  // gaze's to `boneGroups.head`'s (compile.ts enforces this when those groups
  // are declared). Optional/absent entirely means "this topology has no
  // gesture/gaze vocabulary yet" -- computeLayeredAvatarPose degrades to
  // plain posture-only behavior, byte-identical to computeAvatarPose, when
  // no gesture/gaze is active regardless of whether this topology declares
  // any.
  gestures?: Partial<Record<AvatarGestureId, ActionCurveSpec>> & Record<string, ActionCurveSpec>;
  gazes?: Partial<Record<AvatarGazeId, ActionCurveSpec>> & Record<string, ActionCurveSpec>;

  // Named mood presets -- moodId -> a partial map of THIS topology's own
  // `expressionParams` ids to a target bias value "at full mood strength"
  // (not necessarily that param's own min/max). Only params that declare
  // `boneDeltas` have any live, per-frame effect (see actions.ts's
  // computeActiveMoodBias) -- a preset naming a colorDeltas-only param (e.g.
  // library.ts's "colorMood") is harmless but inert in this phase, since
  // colorDeltas are baked into the atlas once at compile time
  // (compile.ts's computeEffectiveSlotColors/recolorAtlas), not re-evaluable
  // per frame.
  moodPresets?: Partial<Record<AvatarMoodId, Record<string, number>>> & Record<string, Record<string, number>>;

  // Mood-driven discrete facial expression shapes (eyebrows/eyes) -- moodId
  // -> a partial map of skin.ts's expressionShapes partIds to the shapeId
  // that mood should show for that part. Deliberately SEPARATE from
  // moodPresets above (which is numeric-only and fed through
  // computeActiveMoodBias's per-frame arithmetic) -- a shape pick is a
  // discrete snap, never eased/scaled by mood strength. Optional/absent
  // entirely means "this topology has no mood-driven facial expression" --
  // resolveAvatarRenderState.ts then resolves no expressionShapeIds for any
  // mood, and renderer.ts's drawAvatar falls back to each part's own base
  // atlas rect (biped-simple's "eyebrows" part's own base rect IS its
  // "neutral" shape, so "no mood active" and "neutral" render identically
  // with no special-casing needed).
  moodExpressionShapes?: Partial<Record<AvatarMoodId, Record<string, string>>> & Record<string, Record<string, string>>;
}
