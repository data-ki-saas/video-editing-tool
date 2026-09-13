/**
 * The Avatar animation engine's seed content: one hand-authored Topology
 * ("biped-simple"), one Skin bound to it ("placeholder-v1", built from
 * placeholderAtlas.ts's procedural art), and one trivial Design ("Sam")
 * wrapping that skin with no overrides. Everything downstream
 * (compile.ts/actions.ts/renderer.ts) is generic over ANY topology/skin/
 * design triple -- this file is the only place in this phase that actually
 * decides what a rig looks like and how big each bone group's motion is.
 * Growing the library later (a second hand-drawn skin, eventually a
 * photo-generated one) means adding another AvatarLibraryEntry here, never
 * touching the engine.
 */
import type { ActionCurveSpec, AvatarAnchor, AvatarTopology, BoneTransform } from "./topology";
import type { AvatarSkin, AvatarSkinPart } from "./skin";
import type { AvatarDesign } from "./design";
import { buildPlaceholderAtlas } from "./placeholderAtlas";

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

const BONE_NAMES = ["root", "torso", "head", "armL", "armR", "legL", "legR"];
const PARENT_INDEX = [-1, ROOT, TORSO, TORSO, TORSO, ROOT, ROOT];

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
];

// Not consumed by anything in this phase (see topology.ts's own doc comment)
// -- "torso" groups the body's core (hip + torso) for a future uniform
// scale edit ("make it fatter"), "limbs" groups all four limbs so the same
// kind of edit could separately target those.
const BONE_GROUPS: Record<string, number[]> = {
  torso: [ROOT, TORSO],
  limbs: [ARM_L, ARM_R, LEG_L, LEG_R],
};

// Not consumed by anything in this phase (see AvatarAnchor's own doc comment
// in topology.ts) -- a head anchor for a future hat/headwear accessory, and
// a symmetric hand pair for a future held prop.
const ANCHORS: AvatarAnchor[] = [
  { anchorId: "head", boneIndex: HEAD, localOffset: { x: 0, y: -120 } },
  { anchorId: "handL", boneIndex: ARM_L, localOffset: { x: 0, y: 115 } },
  { anchorId: "handR", boneIndex: ARM_R, localOffset: { x: 0, y: 115 } },
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

const ACTIONS: AvatarTopology["actions"] = {
  idle: IDLE,
  talk: TALK,
  walk: WALK,
  sit: SIT,
  sleep: SLEEP,
  lookAround: LOOK_AROUND,
};

const BIPED_SIMPLE_TOPOLOGY: AvatarTopology = {
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
};

const placeholderAtlas = buildPlaceholderAtlas();

/**
 * Every part's pivot is chosen so the assembled figure reads correctly at
 * rest against DEFAULT_LOCAL_POSE above -- each pivot is "where, within this
 * part's own drawn rect, does the owning bone's joint sit":
 *  - legL/legR pivot near TOP-center: the hip bone sits at the TOP of each
 *    leg image, which then hangs downward to the feet.
 *  - torso pivots near TOP-center too: the neck/shoulder bone sits at the
 *    top of the torso image, which extends downward to (and slightly past)
 *    the hip -- drawn AFTER (zOrder above) the legs so that overlap reads as
 *    a shirt covering the top of the pants, not the reverse.
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
 * zOrder is authored already ascending here (legs, then torso, then arms,
 * then head, then mouth on top of the head) -- compile.ts re-sorts
 * defensively, but skin.ts's own contract expects this array pre-sorted.
 */
const PLACEHOLDER_SKIN_PARTS: AvatarSkinPart[] = [
  { partId: "legL", boneIndex: LEG_L, pivotX: 21, pivotY: 4, zOrder: 0 },
  { partId: "legR", boneIndex: LEG_R, pivotX: 21, pivotY: 4, zOrder: 1 },
  { partId: "torso", boneIndex: TORSO, pivotX: 60, pivotY: 8, zOrder: 2 },
  { partId: "armL", boneIndex: ARM_L, pivotX: 18, pivotY: 4, zOrder: 3 },
  { partId: "armR", boneIndex: ARM_R, pivotX: 18, pivotY: 4, zOrder: 4 },
  { partId: "head", boneIndex: HEAD, pivotX: 70, pivotY: 128, zOrder: 5 },
  // The mouth "slot" -- see AvatarSkinMouthShape's own doc comment (skin.ts)
  // for why this is its own `parts` entry rather than baked into "head".
  { partId: "mouth", boneIndex: HEAD, pivotX: 25, pivotY: 40, zOrder: 6 },
];

const PLACEHOLDER_SKIN: AvatarSkin = {
  schemaVersion: 1,
  skinId: "placeholder-v1",
  topologyId: BIPED_SIMPLE_TOPOLOGY.topologyId,
  atlas: {
    imageRef: placeholderAtlas.dataUrl,
    partRects: placeholderAtlas.partRects,
  },
  parts: PLACEHOLDER_SKIN_PARTS,
  mouthShapes: [
    { shapeId: "closed", partId: "mouth" },
    { shapeId: "open", partId: "mouth" },
  ],
};

const SEED_FRIENDLY_DESIGN: AvatarDesign = {
  schemaVersion: 1,
  designId: "seed-friendly-1",
  skinId: PLACEHOLDER_SKIN.skinId,
  meta: { name: "Sam" },
};

/** The whole seed Avatar library -- just the one hand-authored entry for
 * this phase (see this file's own doc comment). */
export const AVATAR_LIBRARY: AvatarLibraryEntry[] = [
  { design: SEED_FRIENDLY_DESIGN, skin: PLACEHOLDER_SKIN, topology: BIPED_SIMPLE_TOPOLOGY },
];

/** Looks up a library entry by its Design's own id -- the same id an
 * `AvatarOverlayClip.avatarId` (a later phase's overlay type) would carry.
 * Returns null (never throws) for an unknown id -- compile.ts's
 * getCompiledAvatar is what turns "not found" into a thrown Error, keeping
 * this lookup itself a plain, side-effect-free query. */
export function getAvatarLibraryEntry(avatarId: string): AvatarLibraryEntry | null {
  return AVATAR_LIBRARY.find((entry) => entry.design.designId === avatarId) ?? null;
}
