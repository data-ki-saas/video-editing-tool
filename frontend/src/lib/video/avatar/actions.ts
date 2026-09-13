/**
 * Evaluates a CompiledAvatar's action curves at a given instant -- the pose
 * (per-bone local transform) and the mouth shape are each a PURE function of
 * (actionId, elapsedSeconds, seed): no Math.random(), no Date.now()/
 * performance.now(), no state stored between calls. Same hard invariant
 * ambientEffects.ts/camera3D.ts already hold their own draw functions to, and
 * for the identical reason -- the live rAF preview loop and the export's
 * seeked frame loop must both be able to call this at the same
 * elapsedSeconds, any number of times, in any order, and always get back
 * byte-identical results.
 */
import type { ActionCurveSpec, ActionKeyframe, BoneTransform } from "./topology";
import type { CompiledTopology } from "./compile";
import { ambientEffectSeed, mulberry32 } from "../ambientEffects";

// The identity delta -- x/y/rotation at their additive zero, scaleX/scaleY
// at their multiplicative one (see ActionKeyframe's own doc comment in
// topology.ts for why the two groups have different "no-op" values).
const IDENTITY_DELTA: BoneTransform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };

/** Fills in every omitted field of a keyframe's (necessarily partial) delta
 * with its own field's identity value, so the rest of this module can always
 * work with a fully-populated BoneTransform-shaped delta rather than
 * threading `?? 0`/`?? 1` through every call site. */
function resolveDelta(delta: Partial<BoneTransform>): BoneTransform {
  return {
    x: delta.x ?? IDENTITY_DELTA.x,
    y: delta.y ?? IDENTITY_DELTA.y,
    rotation: delta.rotation ?? IDENTITY_DELTA.rotation,
    scaleX: delta.scaleX ?? IDENTITY_DELTA.scaleX,
    scaleY: delta.scaleY ?? IDENTITY_DELTA.scaleY,
  };
}

/** Linearly interpolates two already-resolved (no missing fields) deltas. */
function lerpDelta(a: BoneTransform, b: BoneTransform, t: number): BoneTransform {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    rotation: a.rotation + (b.rotation - a.rotation) * t,
    scaleX: a.scaleX + (b.scaleX - a.scaleX) * t,
    scaleY: a.scaleY + (b.scaleY - a.scaleY) * t,
  };
}

/** The resolved delta for ONE bone's own keyframes at loop phase `phase`
 * (0..1) -- zero keyframes stays at the identity delta (plain rest pose),
 * one keyframe holds its delta constant regardless of phase, and two or
 * more linearly interpolate between whichever pair straddles `phase`,
 * wrapping across the t=1/t=0 seam so the loop has no jump-cut frame. */
function deltaAtPhase(keyframesForBone: ActionKeyframe[], phase: number): BoneTransform {
  if (keyframesForBone.length === 0) return IDENTITY_DELTA;
  if (keyframesForBone.length === 1) return resolveDelta(keyframesForBone[0].delta);

  const sorted = [...keyframesForBone].sort((a, b) => a.t - b.t);

  for (let i = 0; i < sorted.length - 1; i++) {
    if (phase >= sorted[i].t && phase < sorted[i + 1].t) {
      const span = sorted[i + 1].t - sorted[i].t;
      const localT = span > 0 ? (phase - sorted[i].t) / span : 0;
      return lerpDelta(resolveDelta(sorted[i].delta), resolveDelta(sorted[i + 1].delta), localT);
    }
  }

  // `phase` falls outside every consecutive pair above -- i.e. it's before
  // the first keyframe's own t, or at/after the last one's -- so it belongs
  // to the WRAPPING span from the last keyframe back around to the first,
  // treating the first keyframe's t as if it sat one whole period later.
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const shiftedPhase = phase < first.t ? phase + 1 : phase;
  const span = first.t + 1 - last.t;
  const localT = span > 0 ? (shiftedPhase - last.t) / span : 0;
  return lerpDelta(resolveDelta(last.delta), resolveDelta(first.delta), localT);
}

/** Combines a bone's rest pose with a resolved delta, per the additive
 * (x/y/rotation) vs. multiplicative (scaleX/scaleY) rule ActionKeyframe's
 * own doc comment (topology.ts) specifies. */
function applyDelta(defaultPose: BoneTransform, delta: BoneTransform): BoneTransform {
  return {
    x: defaultPose.x + delta.x,
    y: defaultPose.y + delta.y,
    rotation: defaultPose.rotation + delta.rotation,
    scaleX: defaultPose.scaleX * delta.scaleX,
    scaleY: defaultPose.scaleY * delta.scaleY,
  };
}

// How long one "gaze shift" holds before lookAround picks a new target --
// long enough to read as a deliberate look rather than a nervous twitch,
// short enough that a several-second talking-head shot shows a few distinct
// glances rather than one held indefinitely.
const LOOK_AROUND_SEGMENT_DURATION_SECONDS = 2.2;
// How far off-center a single glance can rotate the head bone, radians --
// modest on purpose: this is a subtle "still paying attention, glancing
// around" tic, not the avatar visibly swiveling to look elsewhere.
const LOOK_AROUND_MAX_ROTATION_RADIANS = 0.35;
// The leading fraction of each segment spent easing from the PREVIOUS
// target toward the new one -- past this point the head holds at the new
// target for the remainder of the segment, same "ease into a held pose"
// shape as this app's Ken Burns epicenter easing (video_math.ts) rather
// than a motion that never settles.
const LOOK_AROUND_EASE_FRACTION = 0.35;

/** The target head-rotation delta for one lookAround "segment" -- a pure
 * function of (seed, segmentIndex), so two different avatar instances (each
 * with their own seed) glance independently, and replaying the identical
 * segment always draws the identical target. Reuses ambientEffects.ts's own
 * hash-then-PRNG pair (`ambientEffectSeed` + `mulberry32`) exactly the way
 * that file's own particle-field layout does -- same "seed a tiny
 * deterministic PRNG from a stable string key" pattern, just applied to a
 * gaze target instead of a particle position. */
function lookAroundTargetRotation(seed: number, segmentIndex: number): number {
  const random = mulberry32(ambientEffectSeed(`${seed}:${segmentIndex}`));
  return (random() * 2 - 1) * LOOK_AROUND_MAX_ROTATION_RADIANS;
}

/** The head-bone rotation delta at `elapsedSeconds` for the lookAround
 * action -- occasional randomized gaze shifts rather than a smooth loop, but
 * still a pure function of time: both the CURRENT segment's target and the
 * PREVIOUS segment's target are recomputed fresh from segment-index math on
 * every call (never read from any stored "last target" variable), so two
 * calls at the same `elapsedSeconds` always agree, and the preview/export
 * split this whole module exists to serve never drifts. */
function computeLookAroundRotation(elapsedSeconds: number, seed: number): number {
  const clampedElapsed = Math.max(0, elapsedSeconds);
  const segmentIndex = Math.floor(clampedElapsed / LOOK_AROUND_SEGMENT_DURATION_SECONDS);
  const segmentPhase = clampedElapsed / LOOK_AROUND_SEGMENT_DURATION_SECONDS - segmentIndex;

  const previousTarget = lookAroundTargetRotation(seed, segmentIndex - 1);
  const currentTarget = lookAroundTargetRotation(seed, segmentIndex);

  if (segmentPhase >= LOOK_AROUND_EASE_FRACTION) return currentTarget;
  const easeT = segmentPhase / LOOK_AROUND_EASE_FRACTION;
  return previousTarget + (currentTarget - previousTarget) * easeT;
}

/** lookAround's own pose evaluator -- special-cased (rather than driven by
 * ordinary keyframe interpolation like every other action) because its
 * motion is randomized-but-segmented, not a smooth fixed loop. Which bone it
 * drives is deliberately NOT hardcoded to a bone name: by convention (see
 * ActionCurveSpec.usesSeed's own doc comment in topology.ts), a `usesSeed`
 * action's spec carries exactly one keyframe, at t=0, with an empty delta --
 * its ONLY purpose is naming the driven bone via that keyframe's own
 * `boneIndex`, never an actual pose sample. This keeps this evaluator
 * generic over whichever bone a given topology calls its "head", instead of
 * assuming every topology names it identically. */
function computeSeededPose(topology: CompiledTopology, spec: ActionCurveSpec, elapsedSeconds: number, seed: number): BoneTransform[] {
  const drivenBoneIndex = spec.keyframes[0]?.boneIndex;
  const rotationDelta = drivenBoneIndex === undefined ? 0 : computeLookAroundRotation(elapsedSeconds, seed);

  return topology.defaultLocalPose.map((defaultPose, boneIndex) => {
    if (boneIndex !== drivenBoneIndex) return { ...defaultPose };
    return { ...defaultPose, rotation: defaultPose.rotation + rotationDelta };
  });
}

/**
 * Phase 7 -- layers a Design's `expressionBias` (design.ts) on top of an
 * already-action-posed frame, one bone at a time: for every paramId the
 * Design has a bias value for, each of that param's own `boneDeltas`
 * (topology.ts's ExpressionBoneDelta) is scaled by the bias value itself
 * (not normalized against min/max -- a bipolar [-1, 1] range, which is what
 * every seed param uses, e.g. library.ts's biped-simple, already means
 * "scale by the value" IS "scale by how far toward that end the slider
 * sits") and added on top of whatever the active action already put there.
 * Same additive-x/y/rotation, multiplicative-scale combination rule as
 * applyDelta above -- an expression bias is just one more delta layered onto
 * the pose, not a different kind of transform. Mutates nothing -- always
 * returns a fresh per-bone array (`pose` itself, and every bone object in
 * it, are left untouched), since callers reuse `pose` in the return value of
 * computeAvatarPose regardless of whether any bias was actually active. */
function applyExpressionBoneDeltas(topology: CompiledTopology, pose: BoneTransform[], expressionBias: Record<string, number> | undefined): BoneTransform[] {
  if (!expressionBias || !topology.expressionParams) return pose;

  const next = pose.map((bone) => ({ ...bone }));
  for (const [paramId, spec] of Object.entries(topology.expressionParams)) {
    const bias = expressionBias[paramId];
    if (!bias || !spec.boneDeltas) continue;
    for (const boneDelta of spec.boneDeltas) {
      const bone = next[boneDelta.boneIndex];
      if (!bone) continue;
      const delta = boneDelta.delta;
      next[boneDelta.boneIndex] = {
        x: bone.x + (delta.x ?? 0) * bias,
        y: bone.y + (delta.y ?? 0) * bias,
        rotation: bone.rotation + (delta.rotation ?? 0) * bias,
        scaleX: bone.scaleX * (1 + ((delta.scaleX ?? 1) - 1) * bias),
        scaleY: bone.scaleY * (1 + ((delta.scaleY ?? 1) - 1) * bias),
      };
    }
  }
  return next;
}

/**
 * The full, index-ordered local pose (length `topology.boneCount`) for every
 * bone at `elapsedSeconds` under `actionId`. Falls back to the plain rest
 * pose, unmodified, for any `actionId` the topology has no curve for --
 * never throws for an unrecognized action, same "degrade toward looking
 * normal rather than error out" convention faceLandmarks.ts's own fallback
 * path already uses elsewhere in this codebase.
 *
 * `seed` only matters for a `usesSeed` action (lookAround) -- every other
 * action's curve is a fixed loop over `elapsedSeconds` alone, so passing a
 * different seed changes nothing about them.
 *
 * `expressionBias` (Phase 7, optional -- omitted call sites behave exactly
 * as before this phase) is a Design's own current expression-slider values
 * (design.ts's `expressionBias`, typically `compiled.design.expressionBias`
 * off a CompiledAvatar, which already carries any per-clip override merged
 * in) -- applied via applyExpressionBoneDeltas above, on top of whatever
 * pose the active action already produced.
 */
export function computeAvatarPose(
  topology: CompiledTopology,
  actionId: string,
  elapsedSeconds: number,
  seed: number,
  expressionBias?: Record<string, number>
): BoneTransform[] {
  const spec = topology.actions[actionId];
  if (!spec) {
    const restPose = topology.defaultLocalPose.map((pose) => ({ ...pose }));
    return applyExpressionBoneDeltas(topology, restPose, expressionBias);
  }

  if (spec.usesSeed) {
    return applyExpressionBoneDeltas(topology, computeSeededPose(topology, spec, elapsedSeconds, seed), expressionBias);
  }

  const phase =
    spec.periodSeconds > 0 ? (((elapsedSeconds % spec.periodSeconds) + spec.periodSeconds) % spec.periodSeconds) / spec.periodSeconds : 0;

  const pose = topology.defaultLocalPose.map((defaultPose, boneIndex) => {
    const keyframesForBone = spec.keyframes.filter((keyframe) => keyframe.boneIndex === boneIndex);
    return applyDelta(defaultPose, deltaAtPhase(keyframesForBone, phase));
  });
  return applyExpressionBoneDeltas(topology, pose, expressionBias);
}

// How often "talk"'s mouth flaps between open/closed -- a generic,
// even-cadence mouth-flap rate, deliberately NOT real lip-sync. A later
// phase drives this instead from real per-word TTS timing (the actual
// narration's own word boundaries), at which point this constant-rate
// fallback stops being used for that path; kept simple here since this
// phase has no per-word timing available to it at all.
const MOUTH_FLAP_INTERVAL_SECONDS = 0.18;

/**
 * Which mouth shape ("open"/"closed") should be drawn right now. Only
 * "talk" (and any talk-family action -- see the id-prefix note below) ever
 * animates the mouth in this phase -- flapping at a fixed cadence -- every
 * other action holds it "closed" throughout.
 *
 * Matches by PREFIX ("talk"...) rather than an exact "talk" check, by
 * convention: a topology can declare extra actions beyond the baseline six
 * (see topology.ts's own doc comment) that are still fundamentally "the
 * character is talking, plus something else" -- e.g. library.ts's
 * "talkEmphasize" gesture -- and those should keep animating the mouth too,
 * not go silent just because their id isn't the literal string "talk". Any
 * new talk-variant action MUST start its id with "talk" for this to pick
 * it up automatically; that's the whole point of the naming convention.
 */
export function computeMouthShapeId(actionId: string, elapsedSeconds: number): string {
  if (!actionId.startsWith("talk")) return "closed";
  const cycleIndex = Math.floor(Math.max(0, elapsedSeconds) / MOUTH_FLAP_INTERVAL_SECONDS);
  return cycleIndex % 2 === 0 ? "open" : "closed";
}

/** How many discrete open/closed flaps `computeMouthShapeIdForWord` below
 * divides a word into -- one per vowel, matched case-insensitively against
 * [aeiou] (diphthongs/silent letters aren't modeled, just a plain count).
 * A vowel-less token (a stray "hmm", or a number/punctuation-only entry the
 * TTS word list can legitimately contain) still counts as 1, never 0 --
 * dividing a word's duration into zero segments would be a divide-by-zero,
 * and a real spoken word should show at least one open/closed flap rather
 * than sitting frozen for its whole span. */
function countVowelSegments(word: string): number {
  const matches = word.match(/[aeiou]/gi);
  return matches ? matches.length : 1;
}

/**
 * Word-level counterpart to computeMouthShapeId above, used instead of it
 * whenever a real TTS narration overlaps the avatar clip's current instant
 * (see CanvasPlayer.tsx/exportTimeline.ts's own avatar-overlay loop) --
 * `progress01` is 0..1 through THIS ONE WORD's own span (derived by the
 * caller from that word's TtsWordTiming.startMs/endMs, not from the whole
 * TtsOverlay), and this divides that span into `countVowelSegments(word)`
 * equal segments, alternating "open"/"closed" by segment parity (segment 0
 * = open, 1 = closed, 2 = open, ...) -- a longer or vowel-heavier word
 * therefore flaps more times across its own duration than a short one,
 * which is the whole point of sizing the flap count off the word itself
 * rather than reusing computeMouthShapeId's fixed MOUTH_FLAP_INTERVAL_SECONDS
 * cadence for every word regardless of length.
 *
 * Still every bit as much an approximation as computeMouthShapeId above --
 * this is vowel-count-driven timing, not real phoneme/viseme alignment (the
 * synthesis call this app uses returns word-level timing, not per-phoneme
 * mouth shapes), just a finer-grained placeholder that at least tracks how
 * MUCH a given word is likely to move the mouth. `progress01` is clamped
 * defensively to [0,1] in case a caller's own boundary math lands a hair
 * outside it from floating-point rounding right at a word's start/end.
 */
export function computeMouthShapeIdForWord(word: string, progress01: number): string {
  const clampedProgress01 = Math.min(Math.max(progress01, 0), 1);
  const vowelSegments = countVowelSegments(word);
  const segmentIndex = Math.min(Math.floor(clampedProgress01 * vowelSegments), vowelSegments - 1);
  return segmentIndex % 2 === 0 ? "open" : "closed";
}
