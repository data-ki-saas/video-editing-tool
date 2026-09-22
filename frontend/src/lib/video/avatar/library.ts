/**
 * The Avatar animation engine's seed content: one hand-authored Topology
 * ("biped-simple") and, riding it, one Skin built from placeholderAtlas.ts's
 * procedural art, wrapped in one trivial Design ("Maya") with no overrides
 * -- the library's only, and therefore default, seed character (two other
 * recolors, "Sam"/"Leo", were removed at the user's request; see
 * AVATAR_LIBRARY's own doc comment below). Everything downstream
 * (compile.ts/actions.ts/renderer.ts) is generic over ANY topology/skin/
 * design triple -- this file is the only place that actually decides what a
 * rig looks like and how big each bone group's motion is. Growing the
 * library later (more recolors, eventually hand-drawn or photo-generated
 * art) means adding another AvatarLibraryEntry here, never touching the
 * engine.
 */
import type { ActionCurveSpec, AvatarAnchor, AvatarBustFraming, AvatarTopology, BoneTransform, ExpressionParamSpec } from "./topology";
import type { AvatarSkin, AvatarSkinColorSlot, AvatarSkinPart, AvatarSkinMouthShape, AvatarSkinGarmentShape, AvatarSkinExpressionShape } from "./skin";
import type { AvatarDesign } from "./design";
import { buildPlaceholderAtlas, TRIM_COLOR, type PlaceholderAtlasPalette } from "./placeholderAtlas";

export interface AvatarLibraryEntry {
  design: AvatarDesign;
  skin: AvatarSkin;
  topology: AvatarTopology;
}

// Bone indices for "biped-simple", named here once so every other constant
// in this file (default pose, action keyframes, skin parts, anchors) can
// reference a bone by meaning instead of a bare magic number. Order matters:
// each bone's own parent index below MUST be smaller, since compile.ts
// requires (and forward kinematics depends on) every parent preceding its
// children in this same array -- root(hip) first, then torso off the hip,
// head/arms off the torso, legs off the hip.
const ROOT = 0; // hip -- the rig's own root, everything else chains off it
const TORSO = 1;
const HEAD = 2;
const ARM_L = 3;
const ARM_R = 4;
const LEG_L = 5;
const LEG_R = 6;
// The rig's first real hand bones -- previously "handL"/"handR" were only a
// bare anchor point (a math offset past the end of armL/armR, see ANCHORS
// below), used just to position held-prop icons with no drawn part of their
// own. As real child bones of armL/armR they get an actual sprite (see
// PLACEHOLDER_SKIN_PARTS) AND automatically inherit their parent arm's
// rotation/scale through the same forward-kinematics chain every other bone
// already uses -- no new parenting mechanism needed.
const HAND_L = 7;
const HAND_R = 8;

const BONE_NAMES = ["root", "torso", "head", "armL", "armR", "legL", "legR", "handL", "handR"];
const PARENT_INDEX = [-1, ROOT, TORSO, TORSO, TORSO, ROOT, ROOT, ARM_L, ARM_R];

// The authoring canvas every bone position/atlas pixel rect below is defined
// against -- portrait-ish per convention (this product's primary reel
// framing), scaled to fit whatever destRect a clip actually has at draw
// time (renderer.ts's own job, fit-by-height).
const RIG_WIDTH = 200;
const RIG_HEIGHT = 400;

/**
 * The rest pose -- a plain standing figure, hip roughly 2/3 down the rig,
 * head at the top, arms at shoulder height, legs below the hip. Every
 * offset below is LOCAL (relative to that bone's own parent -- see
 * BoneTransform's own doc comment in topology.ts), so the figure's actual
 * on-screen joint positions are these values' cumulative sum along the
 * parent chain:
 *   root (hip)  = (100, 258)
 *   torso (neck)= root + (0,-110)  = (100, 148)
 *   head (chin) = torso + (0,-12) = (100, 136)
 *   armL (shldr)= torso + (-42,0) = ( 58, 148)
 *   armR (shldr)= torso + ( 42,0) = (142, 148)
 *   legL (hip)  = root  + (-28,0) = ( 72, 258)
 *   legR (hip)  = root  + ( 28,0) = (128, 258)
 * Each of these joint positions is exactly where its own skin part's pivot
 * is defined to land (see PLACEHOLDER_SKIN_PARTS below) -- the two are
 * designed together, not independently.
 */
const DEFAULT_LOCAL_POSE: BoneTransform[] = [
  { x: 100, y: 258, rotation: 0, scaleX: 1, scaleY: 1 }, // root
  { x: 0, y: -110, rotation: 0, scaleX: 1, scaleY: 1 }, // torso
  { x: 0, y: -12, rotation: 0, scaleX: 1, scaleY: 1 }, // head
  { x: -42, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, // armL
  { x: 42, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, // armR
  { x: -28, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, // legL
  { x: 28, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, // legR
  // handL/handR -- reuses the exact offset the old handL/handR ANCHORS used
  // (armL/armR + local (0, 115)), since that was already the tuned "where a
  // hand sits at the end of the forearm" position; retargeting the anchors
  // themselves onto these new bones (see ANCHORS below) needs a much smaller
  // nudge from here instead.
  { x: 0, y: 115, rotation: 0, scaleX: 1, scaleY: 1 }, // handL
  { x: 0, y: 115, rotation: 0, scaleX: 1, scaleY: 1 }, // handR
];

// "torso"/"limbs" are not consumed by anything in this phase (see
// topology.ts's own doc comment) -- reserved for a future uniform-scale edit.
// "arms"/"head" ARE consumed today: compile.ts's assertLayerOwnsOnlyItsOwnBones
// validates every GESTURES/GAZES keyframe below against these two groups, so
// a gesture/gaze can never reach into a bone its own layer doesn't own.
const BONE_GROUPS: Record<string, number[]> = {
  torso: [ROOT, TORSO],
  limbs: [ARM_L, ARM_R, LEG_L, LEG_R],
  arms: [ARM_L, ARM_R],
  head: [HEAD],
};

// A head anchor for hat/sunglasses accessories, and a hand anchor pair for
// held props (accessories.ts's ACCESSORY_CATALOG) -- handL/handR now ride
// their own HAND_L/HAND_R bone (previously ARM_L/ARM_R directly, with a much
// larger offset standing in for "where the hand roughly is"), so this is now
// just a small "in the palm" nudge from the hand bone's own origin rather
// than the full shoulder-to-hand distance. accessories.ts/compile.ts resolve
// anchors purely by boneIndex + localOffset, so retargeting which bone an
// anchor rides needed no changes there at all.
const ANCHORS: AvatarAnchor[] = [
  { anchorId: "head", boneIndex: HEAD, localOffset: { x: 0, y: -120 } },
  { anchorId: "handL", boneIndex: HAND_L, localOffset: { x: 0, y: 14 } },
  { anchorId: "handR", boneIndex: HAND_R, localOffset: { x: 0, y: 14 } },
];

// A gentle vertical breathing bob shared (at different amplitudes/periods)
// by idle/talk/sit/sleep below -- four samples is enough to read as a
// smooth sine-ish bob once actions.ts linearly interpolates between them,
// without needing a denser hand-authored curve.
function breathingBobKeyframes(boneIndex: number, amplitude: number): ActionCurveSpec["keyframes"] {
  return [
    { t: 0, boneIndex, delta: { y: 0 } },
    { t: 0.25, boneIndex, delta: { y: -amplitude } },
    { t: 0.5, boneIndex, delta: { y: 0 } },
    { t: 0.75, boneIndex, delta: { y: amplitude } },
  ];
}

const IDLE_PERIOD_SECONDS = 3;
const IDLE: ActionCurveSpec = {
  periodSeconds: IDLE_PERIOD_SECONDS,
  // Subtle torso breathing bob -- the only motion in idle.
  keyframes: breathingBobKeyframes(TORSO, 3),
};

const TALK: ActionCurveSpec = {
  // Slightly faster and smaller than idle's own bob -- mouth animation
  // itself is NOT part of this curve at all (see actions.ts's
  // computeMouthShapeId, driven independently off actionId==="talk"); this
  // curve is only the small torso/head sway that reads as "alive" underneath
  // whatever the mouth is doing.
  periodSeconds: 1.8,
  keyframes: [...breathingBobKeyframes(TORSO, 1.5), ...breathingBobKeyframes(HEAD, 1)],
};

const WALK_PERIOD_SECONDS = 1;
// A simple back-and-forth swing curve shared by legs/arms below -- `sign`
// flips which half of the stride this bone starts on, so a leg and its
// opposite-side arm (or the opposite leg) share the identical shape just
// phase-inverted, which is what actually produces a "walk" rather than
// every limb swinging in lockstep.
function strideSwingKeyframes(boneIndex: number, amplitude: number, sign: 1 | -1): ActionCurveSpec["keyframes"] {
  return [
    { t: 0, boneIndex, delta: { rotation: 0 } },
    { t: 0.25, boneIndex, delta: { rotation: sign * amplitude } },
    { t: 0.5, boneIndex, delta: { rotation: 0 } },
    { t: 0.75, boneIndex, delta: { rotation: -sign * amplitude } },
  ];
}
const WALK: ActionCurveSpec = {
  periodSeconds: WALK_PERIOD_SECONDS,
  keyframes: [
    // Legs swing opposite each other (classic alternating gait).
    ...strideSwingKeyframes(LEG_L, 0.4, 1),
    ...strideSwingKeyframes(LEG_R, 0.4, -1),
    // Arms counter-swing against their OWN same-side leg (armL shares
    // legR's phase, armR shares legL's), same cross-body coordination a
    // real walk cycle has.
    ...strideSwingKeyframes(ARM_L, 0.3, -1),
    ...strideSwingKeyframes(ARM_R, 0.3, 1),
    // Root bounces at DOUBLE the stride frequency -- two dips per full
    // stride cycle (one per footstrike), vs. the legs' one full swing.
    { t: 0, boneIndex: ROOT, delta: { y: 0 } },
    { t: 0.25, boneIndex: ROOT, delta: { y: -2 } },
    { t: 0.5, boneIndex: ROOT, delta: { y: 0 } },
    { t: 0.75, boneIndex: ROOT, delta: { y: -2 } },
  ],
};

const SIT: ActionCurveSpec = {
  // Reuses idle's own cadence for the still-breathing torso -- sitting is
  // "idle, but the legs are bent" rather than a wholly different rhythm.
  periodSeconds: IDLE_PERIOD_SECONDS,
  keyframes: [
    ...breathingBobKeyframes(TORSO, 3),
    // A single keyframe per leg holds its delta constant for the whole
    // loop (see ActionCurveSpec's own doc comment) -- a fixed bent-knee
    // angle, not an actual motion.
    { t: 0, boneIndex: LEG_L, delta: { rotation: -0.9 } },
    { t: 0, boneIndex: LEG_R, delta: { rotation: -0.9 } },
  ],
};

const SLEEP: ActionCurveSpec = {
  // Slower AND deeper than idle's own breathing -- a sleeping breath is
  // both, not just one or the other.
  periodSeconds: 4.5,
  keyframes: [
    ...breathingBobKeyframes(TORSO, 5),
    // A single, constant "nodding off" tilt -- head drooped forward/down.
    // Arms are deliberately given no keyframes at all here (they simply
    // stay at defaultLocalPose, i.e. fully at rest).
    { t: 0, boneIndex: HEAD, delta: { rotation: 0.5 } },
  ],
};

// Peak arm-raise rotation for TALK_EMPHASIZE's pointing gesture below, in
// radians, ADDITIVE on top of armR's own DEFAULT_LOCAL_POSE rotation (0 --
// the arm hangs straight down at rest, see that pose's own doc comment).
// renderer.ts's forward-kinematics pass feeds this straight into
// DOMMatrix.rotate, which (per canvas 2D convention) is CLOCKWISE for
// positive degrees -- so a positive delta here sweeps the hanging arm up
// through its own front/center side (toward the torso, where the camera
// effectively "is" for this flat 2D rig) rather than out and around behind
// the body. ~126 degrees lands the hand raised well past horizontal, angled
// in toward center -- short of a full 180 ("straight overhead salute",
// which reads as reaching/waving rather than pointing).
const ARM_POINT_ROTATION_RADIANS = 2.2;

// A non-baseline EXTRA action (see topology.ts's own doc comment on
// AvatarTopology.actions' open string index) -- "talk", but with a periodic
// presenter-style point-at-camera gesture layered on the right arm, for a
// creator who wants their avatar to emphasize a beat rather than just idly
// chatter. Actions don't compose or inherit (a spec is its own complete
// keyframe list, see this file's own module comment), so TALK's own
// torso/head bob is copied here verbatim -- same amplitudes, same bones --
// rather than referenced, specifically so this reads as "the same character
// as talk, plus a gesture" instead of a differently-tuned one.
const TALK_EMPHASIZE: ActionCurveSpec = {
  // Matches TALK's own period exactly (not just "a period in the same
  // range") -- this action IS talk's cadence with a gesture added, not a
  // second, differently-timed rhythm; it also happens to land well inside a
  // natural single-emphasis-beat range (1.6-2s) for the arm gesture itself.
  periodSeconds: 1.8,
  keyframes: [
    ...breathingBobKeyframes(TORSO, 1.5),
    ...breathingBobKeyframes(HEAD, 1),
    // One emphasis beat per loop on armR only -- legs/root/armL get no
    // keyframes at all here (same as TALK), i.e. stay fully at rest, since
    // this is a standing gesture, not a walk. Rest through ~37% of the
    // period, ease up into the raised/pointing pose by ~58%, hold briefly,
    // ease back down to rest by ~88%, then rest for the remainder (the loop
    // wraps from this last keyframe straight back to t=0's rest delta, see
    // ActionCurveSpec's own doc comment in topology.ts).
    { t: 0, boneIndex: ARM_R, delta: { rotation: 0 } },
    { t: 0.37, boneIndex: ARM_R, delta: { rotation: 0 } },
    { t: 0.58, boneIndex: ARM_R, delta: { rotation: ARM_POINT_ROTATION_RADIANS } },
    { t: 0.68, boneIndex: ARM_R, delta: { rotation: ARM_POINT_ROTATION_RADIANS } },
    { t: 0.88, boneIndex: ARM_R, delta: { rotation: 0 } },
  ],
};

const LOOK_AROUND: ActionCurveSpec = {
  // Unused by this action's own special-cased evaluator (see actions.ts's
  // computeSeededPose) -- kept nonzero only to satisfy ActionCurveSpec's
  // type/shape.
  periodSeconds: 1,
  usesSeed: true,
  // Exactly one keyframe, at t=0, with an EMPTY delta -- per
  // ActionCurveSpec.usesSeed's own doc comment (topology.ts), this
  // keyframe's only purpose is naming which bone actions.ts's lookAround
  // evaluator should drive, via its `boneIndex` field. Its `t`/`delta`
  // values are never actually sampled.
  keyframes: [{ t: 0, boneIndex: HEAD, delta: {} }],
};

// Phase 7 -- "biped-simple"'s three expression sliders. Every Design riding
// this topology gets these for free (a Design's own `expressionBias`,
// design.ts, holds current values; a slider absent from that record sits at
// its own `default` below). Bipolar ranges throughout ([-1, 1]) so ONE
// numeric bias, scaled straight onto each bone delta (actions.ts's
// applyExpressionBoneDeltas) or blended between two named colors
// (compile.ts's computeEffectiveSlotColors), covers both directions of the
// mood it represents without needing a separate "how much of the opposite"
// field.
const EXPRESSION_PARAMS: Record<string, ExpressionParamSpec> = {
  // Stern/serious (positive) vs. wide-eyed/surprised (negative) -- a small
  // head-tilt read entirely off HEAD's own rotation, same bone TALK/SLEEP's
  // own curves already animate, just as a static bias rather than a loop.
  browAngle: {
    min: -1,
    max: 1,
    default: 0,
    boneDeltas: [{ boneIndex: HEAD, delta: { rotation: 0.22 } }],
  },
  // Energetic/upright (positive) vs. tired/slumped (negative) -- torso+head
  // both lift or droop together, plus a subtle torso "puff" on the
  // energetic side (scaleY>1) that becomes a subtle slouch on the tired side
  // (scaleY<1).
  energy: {
    min: -1,
    max: 1,
    default: 0,
    boneDeltas: [
      { boneIndex: TORSO, delta: { y: -4, scaleY: 1.04 } },
      { boneIndex: HEAD, delta: { y: -3 } },
    ],
  },
  // A pure mood-color slider with no bone motion of its own -- pushes
  // "pantsColor" (see colorSlotsForPalette below) toward a cool near-black
  // at the "serious/evil" end, or a warm earthy brown at the
  // "friendly/approachable" end. Only affects a skin that actually declares
  // a "pantsColor" slot with `respondsToExpressionParams` including this id
  // (every seed skin below does).
  colorMood: {
    min: -1,
    max: 1,
    default: 0,
    colorDeltas: [{ slotId: "pantsColor", towardColorAtMax: "#14161f", towardColorAtMin: "#8a5a2b" }],
  },
};

const ACTIONS: AvatarTopology["actions"] = {
  idle: IDLE,
  talk: TALK,
  walk: WALK,
  sit: SIT,
  sleep: SLEEP,
  lookAround: LOOK_AROUND,
  // The first non-baseline extra (see topology.ts's own doc comment on
  // AvatarTopology.actions) -- deliberately id-prefixed "talk" (see
  // TALK_EMPHASIZE's own comment) so a future actionId.startsWith("talk")
  // check elsewhere can treat it as a talking variant.
  talkEmphasize: TALK_EMPHASIZE,
};

// Layered motion -- gestures (arm-only, layered on top of whichever posture
// action is already playing) and gazes (head-only) below are all `loop:
// false` one-shots: each starts AND ends its own keyframe list back near
// identity/a held target, so computeLayeredAvatarPose's mergeBoneOverride can
// cleanly hand those bones back once the beat driving them ends. Every
// rotation delta reuses ARM_POINT_ROTATION_RADIANS-scale magnitudes (this
// same rig's own existing "how far can an arm rotate and still read as a
// natural gesture, not a broken joint" calibration) rather than inventing a
// new scale per gesture.

const GESTURE_PERIOD_SECONDS = {
  wave: 1.8,
  point: 1.6,
  pointLeft: 1.6,
  shrug: 1.4,
  openArms: 1.6,
  fistThump: 1.0,
  facepalm: 1.6,
  hitLeft: 1.0,
  hitRight: 1.0,
} as const;

// A friendly side-to-side hand wave -- armR raises to about shoulder-raised
// height then wiggles twice before lowering back to rest.
const WAVE: ActionCurveSpec = {
  periodSeconds: GESTURE_PERIOD_SECONDS.wave,
  loop: false,
  keyframes: [
    { t: 0, boneIndex: ARM_R, delta: { rotation: 0 } },
    { t: 0.15, boneIndex: ARM_R, delta: { rotation: 2.0 } },
    { t: 0.35, boneIndex: ARM_R, delta: { rotation: 1.7 } },
    { t: 0.5, boneIndex: ARM_R, delta: { rotation: 2.0 } },
    { t: 0.65, boneIndex: ARM_R, delta: { rotation: 1.7 } },
    { t: 0.85, boneIndex: ARM_R, delta: { rotation: 2.0 } },
    { t: 1, boneIndex: ARM_R, delta: { rotation: 0 } },
  ],
};

// Raise and hold armR pointing (same rotation TALK_EMPHASIZE's own periodic
// gesture uses), for a deliberate one-shot "look/go there" beat rather than a
// repeating presenter tic.
const POINT: ActionCurveSpec = {
  periodSeconds: GESTURE_PERIOD_SECONDS.point,
  loop: false,
  keyframes: [
    { t: 0, boneIndex: ARM_R, delta: { rotation: 0 } },
    { t: 0.25, boneIndex: ARM_R, delta: { rotation: ARM_POINT_ROTATION_RADIANS } },
    { t: 0.75, boneIndex: ARM_R, delta: { rotation: ARM_POINT_ROTATION_RADIANS } },
    { t: 1, boneIndex: ARM_R, delta: { rotation: 0 } },
  ],
};

// pointRight is POINT under a directional name -- kept as a distinct key
// (rather than replacing "point") so any already-persisted gestureTimeline/
// tag anchor referencing plain "point" keeps working unchanged.
const POINT_RIGHT: ActionCurveSpec = POINT;

// Mirror of POINT_RIGHT onto armL with the opposite sign -- same raise/hold/
// lower shape, pointing off the character's other side.
const POINT_LEFT: ActionCurveSpec = {
  periodSeconds: GESTURE_PERIOD_SECONDS.pointLeft,
  loop: false,
  keyframes: [
    { t: 0, boneIndex: ARM_L, delta: { rotation: 0 } },
    { t: 0.25, boneIndex: ARM_L, delta: { rotation: -ARM_POINT_ROTATION_RADIANS } },
    { t: 0.75, boneIndex: ARM_L, delta: { rotation: -ARM_POINT_ROTATION_RADIANS } },
    { t: 1, boneIndex: ARM_L, delta: { rotation: 0 } },
  ],
};

// Both arms lift slightly and briefly, opposite-signed so they read as
// shoulders shrugging rather than both swinging the same direction.
const SHRUG: ActionCurveSpec = {
  periodSeconds: GESTURE_PERIOD_SECONDS.shrug,
  loop: false,
  keyframes: [
    { t: 0, boneIndex: ARM_L, delta: { rotation: 0 } },
    { t: 0.35, boneIndex: ARM_L, delta: { rotation: -0.8 } },
    { t: 0.65, boneIndex: ARM_L, delta: { rotation: -0.8 } },
    { t: 1, boneIndex: ARM_L, delta: { rotation: 0 } },
    { t: 0, boneIndex: ARM_R, delta: { rotation: 0 } },
    { t: 0.35, boneIndex: ARM_R, delta: { rotation: 0.8 } },
    { t: 0.65, boneIndex: ARM_R, delta: { rotation: 0.8 } },
    { t: 1, boneIndex: ARM_R, delta: { rotation: 0 } },
  ],
};

// A big "ta-da"/welcoming spread -- both arms swing wide and up, opposite
// signs so they open outward rather than both sweeping the same way.
const OPEN_ARMS: ActionCurveSpec = {
  periodSeconds: GESTURE_PERIOD_SECONDS.openArms,
  loop: false,
  keyframes: [
    { t: 0, boneIndex: ARM_L, delta: { rotation: 0 } },
    { t: 0.3, boneIndex: ARM_L, delta: { rotation: -2.4 } },
    { t: 0.7, boneIndex: ARM_L, delta: { rotation: -2.4 } },
    { t: 1, boneIndex: ARM_L, delta: { rotation: 0 } },
    { t: 0, boneIndex: ARM_R, delta: { rotation: 0 } },
    { t: 0.3, boneIndex: ARM_R, delta: { rotation: 2.4 } },
    { t: 0.7, boneIndex: ARM_R, delta: { rotation: 2.4 } },
    { t: 1, boneIndex: ARM_R, delta: { rotation: 0 } },
  ],
};

// A quick, sharp forward punch-like beat -- fast up, brief hold, fast back,
// noticeably quicker than the other gestures' own eases (short period + a
// tight t=0.15-0.35 peak window) so it reads as an emphatic thump, not a slow
// wave.
const FIST_THUMP: ActionCurveSpec = {
  periodSeconds: GESTURE_PERIOD_SECONDS.fistThump,
  loop: false,
  keyframes: [
    { t: 0, boneIndex: ARM_R, delta: { rotation: 0 } },
    { t: 0.15, boneIndex: ARM_R, delta: { rotation: 2.6 } },
    { t: 0.35, boneIndex: ARM_R, delta: { rotation: 2.6 } },
    { t: 1, boneIndex: ARM_R, delta: { rotation: 0 } },
  ],
};

// A two-armed strike toward one side -- both arms swing with the SAME sign
// (unlike SHRUG/OPEN_ARMS' opposite-sign spread) so they read as slamming
// together in one direction, not opening apart. Reuses FIST_THUMP's sharp
// timing/magnitude (fast rise, brief hold, fast release) rather than the
// gentler gestures' easing, since a hit should read as an impact.
const HIT_RIGHT: ActionCurveSpec = {
  periodSeconds: GESTURE_PERIOD_SECONDS.hitRight,
  loop: false,
  keyframes: [
    { t: 0, boneIndex: ARM_L, delta: { rotation: 0 } },
    { t: 0.15, boneIndex: ARM_L, delta: { rotation: 2.6 } },
    { t: 0.35, boneIndex: ARM_L, delta: { rotation: 2.6 } },
    { t: 1, boneIndex: ARM_L, delta: { rotation: 0 } },
    { t: 0, boneIndex: ARM_R, delta: { rotation: 0 } },
    { t: 0.15, boneIndex: ARM_R, delta: { rotation: 2.6 } },
    { t: 0.35, boneIndex: ARM_R, delta: { rotation: 2.6 } },
    { t: 1, boneIndex: ARM_R, delta: { rotation: 0 } },
  ],
};

// Mirror of HIT_RIGHT -- both arms swing the same negative sign instead.
const HIT_LEFT: ActionCurveSpec = {
  periodSeconds: GESTURE_PERIOD_SECONDS.hitLeft,
  loop: false,
  keyframes: [
    { t: 0, boneIndex: ARM_L, delta: { rotation: 0 } },
    { t: 0.15, boneIndex: ARM_L, delta: { rotation: -2.6 } },
    { t: 0.35, boneIndex: ARM_L, delta: { rotation: -2.6 } },
    { t: 1, boneIndex: ARM_L, delta: { rotation: 0 } },
    { t: 0, boneIndex: ARM_R, delta: { rotation: 0 } },
    { t: 0.15, boneIndex: ARM_R, delta: { rotation: -2.6 } },
    { t: 0.35, boneIndex: ARM_R, delta: { rotation: -2.6 } },
    { t: 1, boneIndex: ARM_R, delta: { rotation: 0 } },
  ],
};

// armR raises nearly all the way up and in, toward the face -- handR (see
// GESTURE_HAND_POSE_SHAPES) is deliberately left at its default open-palm
// pose rather than given its own "facepalm" shape: there's no separate
// finger bone to curl against the face, so a plain open hand at the end of
// a fully raised arm already reads as "hand at the face" well enough at this
// simple 2D fidelity.
const FACEPALM: ActionCurveSpec = {
  periodSeconds: GESTURE_PERIOD_SECONDS.facepalm,
  loop: false,
  keyframes: [
    { t: 0, boneIndex: ARM_R, delta: { rotation: 0 } },
    { t: 0.3, boneIndex: ARM_R, delta: { rotation: 2.9 } },
    { t: 0.75, boneIndex: ARM_R, delta: { rotation: 2.9 } },
    { t: 1, boneIndex: ARM_R, delta: { rotation: 0 } },
  ],
};

const GESTURES: AvatarTopology["gestures"] = {
  wave: WAVE,
  point: POINT,
  pointLeft: POINT_LEFT,
  pointRight: POINT_RIGHT,
  shrug: SHRUG,
  openArms: OPEN_ARMS,
  fistThump: FIST_THUMP,
  facepalm: FACEPALM,
  hitLeft: HIT_LEFT,
  hitRight: HIT_RIGHT,
};

// Gazes all drive HEAD's own rotation -- the same single bone lookAround's
// randomized glancing and SLEEP's "nodding off" droop already animate, just
// as a deliberate, named one-shot turn instead of a random tic or a fixed
// sleep pose. This flat 2D rig has no separate yaw/pitch axis, so
// "left"/"right"/"down" are each just a different sign/magnitude of the same
// rotation -- an accepted simplification at this rig's fidelity (see
// EXPRESSION_PARAMS.browAngle's own head-rotation reuse for the same
// convention). Each eases from t=0 to t=1 then holds (loop:false) for as long
// as this gaze stays the active one.
const GAZE_PERIOD_SECONDS = 0.7;
function gazeSpec(targetRotation: number): ActionCurveSpec {
  return {
    periodSeconds: GAZE_PERIOD_SECONDS,
    loop: false,
    keyframes: [
      { t: 0, boneIndex: HEAD, delta: { rotation: 0 } },
      { t: 1, boneIndex: HEAD, delta: { rotation: targetRotation } },
    ],
  };
}

const GAZES: AvatarTopology["gazes"] = {
  lookLeft: gazeSpec(-0.4),
  lookRight: gazeSpec(0.4),
  lookDown: gazeSpec(0.5),
  // An explicit recenter -- a creator directing "look at camera" after a
  // lookLeft/lookRight/lookDown beat gets a deliberate turn back to dead
  // center, not just however the posture layer happens to leave HEAD.
  lookAtCamera: gazeSpec(0),
};

// Named mood presets over browAngle/energy ONLY (both have boneDeltas, so
// both actually animate per-frame -- see actions.ts's computeActiveMoodBias
// and AvatarTopology.moodPresets' own doc comment on why a colorDeltas-only
// param like colorMood is deliberately left out here). Values are chosen
// relative to EXPRESSION_PARAMS' own [-1, 1] bipolar range, not maxed out
// across the board, so a mood reads as a clear nudge rather than every
// preset slamming both sliders to their extremes.
const MOOD_PRESETS: AvatarTopology["moodPresets"] = {
  angry: { browAngle: 0.9, energy: 0.5 },
  happy: { browAngle: -0.5, energy: 0.6 },
  sad: { browAngle: -0.2, energy: -0.8 },
  evil: { browAngle: 1.0, energy: 0.3 },
  calm: { browAngle: -0.1, energy: -0.3 },
  excited: { browAngle: -0.3, energy: 1.0 },
  scared: { browAngle: -0.7, energy: -0.4 },
  laugh: { browAngle: -0.4, energy: 0.9 },
};

// Each of the 8 moods above ALSO snaps the "eyebrows" part (see
// PLACEHOLDER_SKIN_PARTS/EXPRESSION_SHAPES below) to one of 4 curated shapes
// -- a discrete facial tell, layered on top of MOOD_PRESETS' own continuous
// head-tilt/posture nudge, since browAngle/energy alone read too subtly at
// reel scale. Moods without a clearly distinct face just borrow the closest
// of the 4 (evil->angry, excited/laugh->happy, scared->sad, calm->neutral)
// rather than commissioning a 5th shape for a brow difference this small a
// sprite wouldn't read anyway -- "laugh" gets its own facial tell entirely
// from the mouth override (MOOD_MOUTH_SHAPES below), not from a distinct brow.
const MOOD_EXPRESSION_SHAPES: AvatarTopology["moodExpressionShapes"] = {
  angry: { eyebrows: "angry" },
  evil: { eyebrows: "angry" },
  happy: { eyebrows: "happy" },
  excited: { eyebrows: "happy" },
  laugh: { eyebrows: "happy" },
  sad: { eyebrows: "sad" },
  scared: { eyebrows: "sad" },
  calm: { eyebrows: "neutral" },
};

// "laugh" is the one mood that also overrides the MOUTH (see topology.ts's
// own doc comment on moodMouthShapeIds for why this is a separate field from
// MOOD_EXPRESSION_SHAPES) -- while a "laugh" mood beat is active, the mouth
// snaps to the dedicated wide-open/teeth/corners-up shape below regardless of
// narration word timing. No other mood is listed here, so every other mood
// leaves the mouth exactly as word-driven lip-sync computes it.
const MOOD_MOUTH_SHAPES: AvatarTopology["moodMouthShapeIds"] = {
  laugh: "laughOpen",
};

// Gesture-driven hand pose -- which of the "handL"/"handR" parts' own
// EXPRESSION_SHAPES (below) should be active while a given gesture's beat is
// playing. Every gesture NOT listed here leaves both hands at their own base
// rect (the open-palm pose) -- wave/shrug/openArms/facepalm all read fine
// with an open hand at this simple 2D fidelity (facepalm in particular --
// see FACEPALM's own comment above -- an open hand at the face is exactly as
// good a "no separate finger bone" approximation as the old bare-arm-end
// was). hitLeft/hitRight rotate BOTH arms the same sign (see HIT_LEFT/
// HIT_RIGHT above), so both hands fist for either.
const GESTURE_HAND_POSE_SHAPES: NonNullable<AvatarTopology["gestureHandPoseShapeIds"]> = {
  point: { handR: "handRPoint" },
  pointRight: { handR: "handRPoint" },
  pointLeft: { handL: "handLPoint" },
  fistThump: { handR: "handRFist" },
  hitLeft: { handL: "handLFist", handR: "handRFist" },
  hitRight: { handL: "handLFist", handR: "handRFist" },
};

// Phase 8 ("Portrait mode") -- the hip joint (ROOT, see DEFAULT_LOCAL_POSE's
// own comment: "root (hip) = (100, 258)") is exactly where the legs attach,
// so hiding LEG_L/LEG_R and fitting-by-height to just past that y (rather
// than the full 400-tall rig) is what turns "full body" into "hands+torso,
// no legs" -- the "sitting position" framing this phase's own feature
// request asked for. The +42 over the bare hip y=258 is slack for the
// HAND_L/HAND_R bones (armL/armR + local (0, 115), landing at world y=263,
// same position the old handL/handR anchors already used) PLUS their own
// drawn hand sprite, which -- unlike the old bare anchor point -- extends a
// further ~30px below that bone (pivot near its own top, same convention
// armL/armR's own pivot uses): worst case (the "open" pose's own 34px-tall
// rect) bottoms out at world y ~293, plus a few more px of slack for
// idle/talk/sleep's own breathing bob (which translates TORSO, and so
// everything below it in the chain) -- without this, a hand would render a
// few px past this framing's own destRect bottom edge on some frames.
const BUST_FRAMING: AvatarBustFraming = {
  hiddenBoneIndices: [LEG_L, LEG_R],
  frameHeight: 300,
};

// Exported so avatar_gen's frontend client (generatedLibrary.ts) can bind a
// Phase-6 photo-generated Skin to this exact same shared Topology -- every
// generated skin rides "biped-simple" too (see
// backend/src/avatar_gen/service.py's own _TOPOLOGY_ID), so there's no
// separate topology to fetch or resolve for one.
export const BIPED_SIMPLE_TOPOLOGY: AvatarTopology = {
  schemaVersion: 1,
  topologyId: "biped-simple",
  rigWidth: RIG_WIDTH,
  rigHeight: RIG_HEIGHT,
  boneNames: BONE_NAMES,
  parentIndex: PARENT_INDEX,
  defaultLocalPose: DEFAULT_LOCAL_POSE,
  boneGroups: BONE_GROUPS,
  anchors: ANCHORS,
  actions: ACTIONS,
  expressionParams: EXPRESSION_PARAMS,
  bustFraming: BUST_FRAMING,
  gestures: GESTURES,
  gazes: GAZES,
  moodPresets: MOOD_PRESETS,
  moodExpressionShapes: MOOD_EXPRESSION_SHAPES,
  moodMouthShapeIds: MOOD_MOUTH_SHAPES,
  gestureHandPoseShapeIds: GESTURE_HAND_POSE_SHAPES,
};

const MOUTH_SHAPES: AvatarSkinMouthShape[] = [
  { shapeId: "closed", partId: "mouth" },
  { shapeId: "open", partId: "mouth" },
  { shapeId: "laughOpen", partId: "mouth" },
];

// Mood-driven eyebrow shapes (see MOOD_EXPRESSION_SHAPES above) -- "neutral"
// is deliberately not just "the absence of a shape": it's also the
// "eyebrows" part's own BASE atlas rect (placeholderAtlas.ts's partRects),
// so "no mood active" and "calm" render pixel-identical with no extra
// fallback logic in compile.ts/renderer.ts.
const EXPRESSION_SHAPES: AvatarSkinExpressionShape[] = [
  { shapeId: "neutral", partId: "eyebrows" },
  { shapeId: "angry", partId: "eyebrows" },
  { shapeId: "happy", partId: "eyebrows" },
  { shapeId: "sad", partId: "eyebrows" },
  // Blink (actions.ts's computeEyeShapeId) -- named "eyeOpen"/"eyeClosed"
  // rather than plain "open"/"closed" since the atlas's partRects is one
  // flat namespace shared by every part's shapes, and "mouth" already owns
  // those two ids. "eyeOpen" is also the "eyes" part's own base atlas rect,
  // same "base rect IS the default shape" convention as eyebrows/"neutral"
  // above.
  { shapeId: "eyeOpen", partId: "eyes" },
  { shapeId: "eyeClosed", partId: "eyes" },
  // Gesture-driven hand pose (see GESTURE_HAND_POSE_SHAPES above) -- "open"
  // is deliberately not listed, same "base rect IS the default shape"
  // convention as eyebrows/"neutral" and eyes/"eyeOpen" above. shapeIds are
  // globally unique per hand ("handLFist" not "fist") since this skin's
  // whole `atlas.partRects` is one flat namespace shared by every part's
  // shapes -- a bare "fist" would collide between handL's and handR's own
  // (different) rects.
  { shapeId: "handLFist", partId: "handL" },
  { shapeId: "handLPoint", partId: "handL" },
  { shapeId: "handRFist", partId: "handR" },
  { shapeId: "handRPoint", partId: "handR" },
];

// Phase 8 ("selectable torsos") -- "plainShirt" (the base "torso" rect every
// skin already has) is deliberately NOT listed here; a Design's `garmentId`
// left absent/unresolvable already falls back to it (compile.ts), same
// convention MOUTH_SHAPES itself doesn't need a special "no override" entry
// for either.
const GARMENT_SHAPES: AvatarSkinGarmentShape[] = [
  { shapeId: "polo", partId: "torso" },
  { shapeId: "blazer", partId: "torso" },
  { shapeId: "suit", partId: "torso" },
  // "torsoTrim" -- the SAME three garmentIds, resolved against a SEPARATE
  // overlay part (see PLACEHOLDER_SKIN_PARTS' own "torsoTrim" entry and
  // compile.ts's compileSkin, which resolves each part's own garment
  // substitution independently) so an outfit change updates the collar/
  // button accent art alongside the silhouette, without the two parts'
  // identical shapeId strings colliding in the atlas's one flat partRects
  // namespace (compile.ts's part-scoped `${partId}::${shapeId}` rect key).
  { shapeId: "polo", partId: "torsoTrim" },
  { shapeId: "blazer", partId: "torsoTrim" },
  { shapeId: "suit", partId: "torsoTrim" },
];

/**
 * Every part's pivot is chosen so the assembled figure reads correctly at
 * rest against DEFAULT_LOCAL_POSE above -- each pivot is "where, within this
 * part's own drawn rect, does the owning bone's joint sit":
 *  - legL/legR pivot near TOP-center: the hip bone sits at the TOP of each
 *    leg image, which then hangs downward to the feet.
 *  - neck (see NECK_RECT's own doc comment in placeholderAtlas.ts) rides the
 *    SAME bone as torso, pivot also near TOP-center, drawn BEFORE (lower
 *    zOrder than) torso on purpose: it's a plain, fully-opaque skin-tone
 *    patch, so torso's own opaque shirt body (drawn after, on top) hides it
 *    everywhere EXCEPT the blazer/suit garments' open-collar cutout (a
 *    deliberately fully-transparent cut -- placeholderAtlas.ts's
 *    cutGarmentNotch) -- that cutout has nothing else drawn under it, so
 *    without "neck" underneath it reveals raw video instead of skin.
 *  - torso pivots near TOP-center too: the neck/shoulder bone sits at the
 *    top of the torso image, which extends downward to (and slightly past)
 *    the hip -- drawn AFTER (zOrder above) the legs (AND "neck") so that
 *    overlap reads as a shirt covering the top of the pants (and hiding
 *    "neck" except through its own cutout), not the reverse.
 *  - armL/armR pivot near TOP-center: the shoulder bone sits at the top of
 *    each arm image, hanging down to the hand.
 *  - head pivots near BOTTOM-center: the neck/chin bone sits at the BOTTOM
 *    of the head image, which extends upward to cover the skull -- see
 *    skin.ts's own doc comment for why a pivot doesn't have to sit inside
 *    the image's own visible content.
 *  - the mouth slot's pivot is chosen so a small swappable rect lands in
 *    the lower-middle of the face regardless of which shape ("open"/
 *    "closed") is active -- both shapes share one rect size (see
 *    placeholderAtlas.ts) specifically so one shared pivot keeps them
 *    aligned to each other.
 * zOrder is authored already ascending here (legs, then neck, then torso,
 * then arms, then head, then mouth on top of the head) -- compile.ts
 * re-sorts defensively, but skin.ts's own contract expects this array
 * pre-sorted.
 */
const PLACEHOLDER_SKIN_PARTS: AvatarSkinPart[] = [
  { partId: "legL", boneIndex: LEG_L, pivotX: 21, pivotY: 4, zOrder: 0 },
  { partId: "legR", boneIndex: LEG_R, pivotX: 21, pivotY: 4, zOrder: 1 },
  { partId: "neck", boneIndex: TORSO, pivotX: 32, pivotY: 24, zOrder: 2 },
  { partId: "torso", boneIndex: TORSO, pivotX: 60, pivotY: 8, zOrder: 3 },
  // "torsoTrim" -- rides the SAME bone/pivot as "torso" (see its own doc
  // comment in placeholderAtlas.ts for why a separate rect, not a second
  // color fill on "torso" itself, is what makes trimColor independently
  // recolorable), drawn just above it so the collar/button accent shows over
  // the shirt fill.
  { partId: "torsoTrim", boneIndex: TORSO, pivotX: 60, pivotY: 8, zOrder: 3.5 },
  { partId: "armL", boneIndex: ARM_L, pivotX: 18, pivotY: 4, zOrder: 4 },
  { partId: "armR", boneIndex: ARM_R, pivotX: 18, pivotY: 4, zOrder: 5 },
  // "handL"/"handR" -- the rig's first real drawn hand, riding the new
  // HAND_L/HAND_R bones (see this file's own top-of-file comment). pivot
  // near TOP-center, same convention armL/armR's own pivot already uses: the
  // wrist/forearm joint sits at the top of the hand image, which extends
  // downward to the fingertips. zOrder sits just above its own arm (so a
  // hand draws over its own forearm at rest) but below "head" -- when a
  // gesture raises an arm past the head, renderer.ts's own raised-arm defer
  // logic (which a hand bone's own zero local rotation would otherwise skip
  // entirely -- see that file's own comment) re-orders both the arm AND its
  // hand to draw last, in this same relative order, so the hand still sits
  // on top of its own arm even then.
  { partId: "handL", boneIndex: HAND_L, pivotX: 14, pivotY: 4, zOrder: 4.5 },
  { partId: "handR", boneIndex: HAND_R, pivotX: 14, pivotY: 4, zOrder: 5.5 },
  { partId: "head", boneIndex: HEAD, pivotX: 70, pivotY: 128, zOrder: 6 },
  // The eyes "slot" -- previously baked directly into "head" (two fixed
  // dots, never animated); now its own `parts` entry so blink
  // (actions.ts's computeEyeShapeId) can swap it independently every frame.
  // Pivot reproduces the exact same world position the old baked dots sat
  // at: 66px above HEAD's own joint (the chin), centered on it.
  { partId: "eyes", boneIndex: HEAD, pivotX: 30, pivotY: 76, zOrder: 7 },
  // The eyebrows "slot" -- see AvatarSkinExpressionShape's own doc comment
  // (skin.ts) for why this is its own `parts` entry. Sits 14px above the
  // "eyes" part above -- see placeholderAtlas.ts's EYEBROWS_RECT/EYES_RECT
  // for the exact geometry both were authored against together.
  { partId: "eyebrows", boneIndex: HEAD, pivotX: 30, pivotY: 88, zOrder: 8 },
  // The mouth "slot" -- see AvatarSkinMouthShape's own doc comment (skin.ts)
  // for why this is its own `parts` entry rather than baked into "head".
  { partId: "mouth", boneIndex: HEAD, pivotX: 25, pivotY: 40, zOrder: 9 },
];

/** Phase 7's two recolorable slots -- shirt (targets "torso" alone) and
 * pants (targets both legs) -- built from whichever palette a given seed
 * skin actually resolved to (buildPlaceholderAtlas's own `resolvedPalette`),
 * so `defaultColor` always matches what's really baked into that skin's
 * atlas pixels. Deliberately NOT a "skinTone"/"hairColor" slot: the head
 * part's atlas rect bakes skin tone, hair cap, AND eyes into one rect (see
 * placeholderAtlas.ts's drawHead), so a whole-rect recolor (compile.ts's
 * source-atop tint) would flatten all three to one color -- shirt/pants are
 * each a single flat fill with nothing else sharing their rect, which is
 * what actually makes them safely recolorable this way. */
function colorSlotsForPalette(palette: PlaceholderAtlasPalette): AvatarSkinColorSlot[] {
  return [
    { slotId: "shirtColor", targetPartIds: ["torso"], defaultColor: palette.shirtColor },
    {
      slotId: "pantsColor",
      targetPartIds: ["legL", "legR"],
      defaultColor: palette.pantsColor,
      respondsToExpressionParams: ["colorMood"],
    },
    // "handColor" -- defaults to this skin's own skin tone (a hand is drawn
    // in the same flat skin-tone fill as an arm), so an unedited Design's
    // hands render pixel-identical to its own arms with no special-casing.
    { slotId: "handColor", targetPartIds: ["handL", "handR"], defaultColor: palette.skinTone },
    // "trimColor" -- targets ONLY the "torsoTrim" overlay part (never
    // "torso" itself), so a creator can recolor the collar/button accent
    // independently of the shirt's own base color. Default matches
    // TRIM_COLOR, the fixed flat color drawTorsoTrim*'s own accent art is
    // actually drawn with (see placeholderAtlas.ts).
    { slotId: "trimColor", targetPartIds: ["torsoTrim"], defaultColor: TRIM_COLOR },
  ];
}

/** Builds one seed Skin bound to `biped-simple` -- every seed character
 * shares the exact same rig alignment (PLACEHOLDER_SKIN_PARTS/MOUTH_SHAPES
 * above are structural, not per-character), so growing the library (Phase 5)
 * is just calling this again with a new `skinId` + palette, never touching
 * parts/pivots/zOrder. */
function buildSeedSkin(skinId: string, palette: Partial<PlaceholderAtlasPalette>): AvatarSkin {
  const atlas = buildPlaceholderAtlas(palette);
  return {
    schemaVersion: 1,
    skinId,
    topologyId: BIPED_SIMPLE_TOPOLOGY.topologyId,
    atlas: { imageRef: atlas.dataUrl, partRects: atlas.partRects },
    parts: PLACEHOLDER_SKIN_PARTS,
    mouthShapes: MOUTH_SHAPES,
    colorSlots: colorSlotsForPalette(atlas.resolvedPalette),
    garmentShapes: GARMENT_SHAPES,
    expressionShapes: EXPRESSION_SHAPES,
  };
}

// "Sam" and "Leo" (the original placeholder-v1/v3 recolors) were removed at
// the user's request -- Maya is now this library's only, and therefore
// default, seed character (AVATAR_LIBRARY[0], read as the default by every
// caller that falls back to "the first seed entry" -- AvatarFramingDialog's
// own initial/reset avatarId state). A project whose timeline still
// references the old "seed-friendly-1"/"seed-leo-1" designIds will no longer
// resolve (getAvatarLibraryEntry returns null) -- an accepted consequence
// for this POC-phase app, not a migration this change attempts to paper
// over.
const MAYA_SKIN = buildSeedSkin("placeholder-v2", {
  skinTone: "#c98a5e",
  shirtColor: "#9a3f6b",
  pantsColor: "#22344a",
  hairColor: "#241a14",
});

const SEED_MAYA_DESIGN: AvatarDesign = {
  schemaVersion: 1,
  designId: "seed-maya-1",
  skinId: MAYA_SKIN.skinId,
  meta: { name: "Maya" },
};

/** The whole seed Avatar library -- one hand-authored entry, riding
 * `biped-simple` (see this file's own doc comment on how growing the library
 * mostly means adding entries here, not new topology/engine code). */
export const AVATAR_LIBRARY: AvatarLibraryEntry[] = [
  { design: SEED_MAYA_DESIGN, skin: MAYA_SKIN, topology: BIPED_SIMPLE_TOPOLOGY },
];

/** Looks up a library entry by its Design's own id -- the same id an
 * `AvatarOverlayClip.avatarId` (a later phase's overlay type) would carry.
 * Returns null (never throws) for an unknown id -- compile.ts's
 * getCompiledAvatar is what turns "not found" into a thrown Error, keeping
 * this lookup itself a plain, side-effect-free query. */
export function getAvatarLibraryEntry(avatarId: string): AvatarLibraryEntry | null {
  return AVATAR_LIBRARY.find((entry) => entry.design.designId === avatarId) ?? null;
}
