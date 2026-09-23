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
import type { ActionCurveSpec, ActionKeyframe, BoneTransform, ExpressionParamSpec } from "./topology";
import type { CompiledAccessory, CompiledTopology } from "./compile";
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

/** Applies every attached accessory's own `poseBoneDeltas` (compile.ts's
 * CompiledAccessory, resolved from accessories.ts's
 * AccessoryCatalogEntry.restPoseArmRotationRadians/restPoseForearmRotationRadians,
 * sign already mirrored for "handL" and boneIndex already resolved there) --
 * additive onto each named bone's existing rotation (same convention as
 * applyExpressionBoneDeltas), so this is a BASE-POSTURE-level bias, applied
 * before any gesture/gaze merge -- a gesture later targeting the same arm
 * bone still fully replaces it (mergeBoneOverride's "highest layer owning a
 * bone wins outright" rule), it's never fought or double-added. Mutates
 * nothing, same "always return a fresh array" contract as every other pose
 * function here. A no-op (returns `pose` itself, not a copy) when nothing's
 * attached or nothing attached sets either field, so a clip with no held-prop
 * pose bias at all costs nothing extra per frame. */
function applyHeldAccessoryPoseBias(pose: BoneTransform[], accessories?: CompiledAccessory[]): BoneTransform[] {
  if (!accessories || accessories.length === 0) return pose;
  const deltas = accessories.flatMap((accessory) => accessory.poseBoneDeltas);
  if (deltas.length === 0) return pose;

  const next = pose.map((bone) => ({ ...bone }));
  for (const { boneIndex, rotationDelta } of deltas) {
    const bone = next[boneIndex];
    if (!bone) continue;
    next[boneIndex] = { ...bone, rotation: bone.rotation + rotationDelta };
  }
  return next;
}

/** `spec`'s own loop phase (0..1) at `elapsedSeconds` -- wraps modulo
 * `periodSeconds` for an ordinary looping spec (`loop` omitted or true, every
 * spec authored before the layered-motion redesign), or clamps to [0,1]
 * without wrapping for a `loop: false` one-shot (a gesture/gaze spec),
 * so it plays through once from its own t=0 and then holds at t=1 rather
 * than restarting. */
function phaseForSpec(spec: ActionCurveSpec, elapsedSeconds: number): number {
  if (spec.periodSeconds <= 0) return 0;
  if (spec.loop === false) {
    return Math.min(Math.max(elapsedSeconds / spec.periodSeconds, 0), 1);
  }
  return (((elapsedSeconds % spec.periodSeconds) + spec.periodSeconds) % spec.periodSeconds) / spec.periodSeconds;
}

/** The full, index-ordered local pose for every bone at `elapsedSeconds`
 * under one ordinary (non-seeded) keyframe spec -- the per-bone
 * interpolation loop every plain action curve shares, factored out so
 * computeLayeredAvatarPose's gesture/gaze layers can reuse it against their
 * OWN spec/elapsedSeconds without going through a whole-topology actionId
 * lookup. */
function poseFromSpec(topology: CompiledTopology, spec: ActionCurveSpec, elapsedSeconds: number): BoneTransform[] {
  const phase = phaseForSpec(spec, elapsedSeconds);
  return topology.defaultLocalPose.map((defaultPose, boneIndex) => {
    const keyframesForBone = spec.keyframes.filter((keyframe) => keyframe.boneIndex === boneIndex);
    return applyDelta(defaultPose, deltaAtPhase(keyframesForBone, phase));
  });
}

/** The posture layer's own pose -- everything computeAvatarPose used to do,
 * minus the expressionBias step, so computeLayeredAvatarPose can merge
 * gesture/gaze overrides in BEFORE bias is applied once, last, over the
 * fully-merged pose (same order plain computeAvatarPose already used: action
 * pose, then bias). */
function computePosturePose(topology: CompiledTopology, actionId: string, elapsedSeconds: number, seed: number): BoneTransform[] {
  const spec = topology.actions[actionId];
  if (!spec) return topology.defaultLocalPose.map((pose) => ({ ...pose }));
  if (spec.usesSeed) return computeSeededPose(topology, spec, elapsedSeconds, seed);
  return poseFromSpec(topology, spec, elapsedSeconds);
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
 *
 * `accessories` (optional -- typically `compiled.accessories` off the same
 * CompiledAvatar) layers each attached accessory's own default held-prop arm
 * pose in via applyHeldAccessoryPoseBias, BEFORE expressionBias -- see that
 * function's own doc comment.
 *
 * Kept as a single-action, single-layer function (unchanged signature and
 * behavior) for the call sites that only ever need one posture pose in
 * isolation -- gallery thumbnails, AvatarFramingDialog's own live preview
 * canvas. See computeLayeredAvatarPose below for the multi-layer version
 * CanvasPlayer/exportTimeline's real playback uses.
 */
export function computeAvatarPose(
  topology: CompiledTopology,
  actionId: string,
  elapsedSeconds: number,
  seed: number,
  expressionBias?: Record<string, number>,
  accessories?: CompiledAccessory[]
): BoneTransform[] {
  const posturePose = applyHeldAccessoryPoseBias(computePosturePose(topology, actionId, elapsedSeconds, seed), accessories);
  return applyExpressionBoneDeltas(topology, posturePose, expressionBias);
}

/** Which gesture/gaze (if any) is layered on top of the posture action right
 * now, plus each one's own elapsedSeconds -- relative to that BEAT's own
 * start, not the clip's global clock, so a `loop: false` gesture/gaze spec
 * always plays from its own t=0 regardless of when in the clip it started.
 * See resolveAvatarRenderState.ts (CanvasPlayer.tsx/exportTimeline.ts's
 * shared resolver) for how this gets built from a clip's gestureTimeline/
 * gazeTimeline plus any tag-derived beats. */
export interface AvatarLayerActivation {
  postureActionId: string;
  gesture?: { gestureId: string; elapsedSeconds: number };
  gaze?: { gazeId: string; elapsedSeconds: number };
}

/** For every bone `overrideSpec` has at least one keyframe for, REPLACES
 * `base`'s own value with `overridePose`'s -- never sums the two. This is the
 * "highest-priority layer owning a bone wins outright" merge rule: a
 * gesture/gaze scoped to arms/head should fully take over those specific
 * bones (an additive stack would double-displace an arm the posture layer
 * already moved, e.g. during "walk"), while every bone the override spec
 * doesn't mention is left exactly as the layer underneath produced it. */
function mergeBoneOverride(base: BoneTransform[], overridePose: BoneTransform[], overrideSpec: ActionCurveSpec): BoneTransform[] {
  const overriddenBoneIndices = new Set(overrideSpec.keyframes.map((keyframe) => keyframe.boneIndex));
  if (overriddenBoneIndices.size === 0) return base;
  return base.map((bone, boneIndex) => (overriddenBoneIndices.has(boneIndex) ? overridePose[boneIndex] : bone));
}

/**
 * The layered-motion redesign's real pose function -- posture (whichever
 * action `activation.postureActionId` names, exactly as computeAvatarPose
 * would resolve it) computed first, then gesture's own arm bones and gaze's
 * own head bone (whichever are active) REPLACE that pose's values for just
 * those bones (mergeBoneOverride), and finally `expressionBias` is applied
 * once over the fully-merged result -- same relative order computeAvatarPose
 * always used (action pose, then bias), just with an extra merge step
 * in between. With no gesture/gaze active this produces the exact same
 * result as computeAvatarPose (both funnel through computePosturePose +
 * applyExpressionBoneDeltas), so a clip with no gesture/gaze timelines at
 * all renders byte-identically to before this redesign. */
export function computeLayeredAvatarPose(
  topology: CompiledTopology,
  activation: AvatarLayerActivation,
  elapsedSeconds: number,
  seed: number,
  expressionBias?: Record<string, number>,
  accessories?: CompiledAccessory[]
): BoneTransform[] {
  let pose = computePosturePose(topology, activation.postureActionId, elapsedSeconds, seed);
  pose = applyHeldAccessoryPoseBias(pose, accessories);

  const gestureSpec = activation.gesture ? topology.gestures?.[activation.gesture.gestureId] : undefined;
  if (gestureSpec && activation.gesture) {
    pose = mergeBoneOverride(pose, poseFromSpec(topology, gestureSpec, activation.gesture.elapsedSeconds), gestureSpec);
  }

  const gazeSpec = activation.gaze ? topology.gazes?.[activation.gaze.gazeId] : undefined;
  if (gazeSpec && activation.gaze) {
    pose = mergeBoneOverride(pose, poseFromSpec(topology, gazeSpec, activation.gaze.elapsedSeconds), gazeSpec);
  }

  return applyExpressionBoneDeltas(topology, pose, expressionBias);
}

// Mood beats ease in/out rather than snapping, matching this product's own
// "eases back to normal automatically" bias elsewhere (e.g. the Ken Burns
// zoom epicenter) -- symmetric in/out durations, short enough to read as
// responsive to a tag, long enough not to look like a hard cut.
const MOOD_EASE_IN_SECONDS = 0.4;
const MOOD_EASE_OUT_SECONDS = 0.4;

/** Scales every paramId in `preset` by `strength` (0..1), dropping any
 * paramId this topology's own expressionParams has no `boneDeltas` for --
 * see AvatarTopology.moodPresets's own doc comment on why a colorDeltas-only
 * param (e.g. "colorMood") can't be animated per-frame in this phase. */
function scaleMoodPreset(
  preset: Record<string, number>,
  expressionParams: Record<string, ExpressionParamSpec>,
  strength: number
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [paramId, targetValue] of Object.entries(preset)) {
    if (!expressionParams[paramId]?.boneDeltas) continue;
    result[paramId] = targetValue * strength;
  }
  return result;
}

/**
 * The effective expressionBias contribution from a clip's own moodTimeline
 * at `localElapsedMs`, or `undefined` when nothing is active (in which case
 * the caller should just keep using the Design's own static expressionBias
 * unchanged, exactly as before this redesign). Pure function of its inputs --
 * no stored "last mood" state -- same discipline as computeLookAroundRotation
 * above, so live preview and export agree byte-for-byte at any instant.
 *
 * A currently-active beat eases IN over MOOD_EASE_IN_SECONDS from its own
 * startMs (full strength once that ramp completes, held for the rest of the
 * beat). Once a beat's own endMs passes with no NEXT beat yet covering this
 * instant, its preset eases back OUT toward neutral over MOOD_EASE_OUT_SECONDS
 * rather than vanishing on the exact frame the beat ends -- a short window
 * during which computeActiveMoodBias keeps returning a fading contribution
 * from the most recently ended beat.
 */
export function computeActiveMoodBias(
  moodPresets: Record<string, Record<string, number>> | undefined,
  expressionParams: Record<string, ExpressionParamSpec> | undefined,
  moodTimeline: { moodId: string; startMs: number; endMs: number }[] | undefined,
  localElapsedMs: number
): Record<string, number> | undefined {
  if (!moodPresets || !expressionParams || !moodTimeline || moodTimeline.length === 0) return undefined;

  const sorted = [...moodTimeline].sort((a, b) => a.startMs - b.startMs);
  const active = sorted.find((beat) => localElapsedMs >= beat.startMs && localElapsedMs < beat.endMs);
  if (active) {
    const preset = moodPresets[active.moodId];
    if (!preset) return undefined;
    const easeInMs = MOOD_EASE_IN_SECONDS * 1000;
    const strength = easeInMs > 0 ? Math.min((localElapsedMs - active.startMs) / easeInMs, 1) : 1;
    return scaleMoodPreset(preset, expressionParams, strength);
  }

  // No beat covers this instant -- ease the most recently ENDED beat's own
  // preset back toward neutral for a short window afterward.
  let justEnded: { moodId: string; startMs: number; endMs: number } | undefined;
  for (const beat of sorted) {
    if (beat.endMs <= localElapsedMs) justEnded = beat;
  }
  if (!justEnded) return undefined;

  const preset = moodPresets[justEnded.moodId];
  if (!preset) return undefined;
  const easeOutMs = MOOD_EASE_OUT_SECONDS * 1000;
  const msSinceEnd = localElapsedMs - justEnded.endMs;
  if (easeOutMs <= 0 || msSinceEnd >= easeOutMs) return undefined;
  return scaleMoodPreset(preset, expressionParams, 1 - msSinceEnd / easeOutMs);
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
 *
 * Divides into `2 * vowelSegments + 1` slots, alternating closed/open/
 * closed/open/.../closed -- so every word both STARTS and ENDS "closed"
 * (a leading/trailing consonant), with "open" only in between. An earlier
 * version alternated `vowelSegments` slots directly starting from "open"
 * (segment 0 = open) -- which meant any single-vowel word (the overwhelming
 * majority of short English function words: "the", "a", "to", "on", "is",
 * "we"...) stayed "open" for its ENTIRE span, since a 1-segment word never
 * reached a second, "closed" segment. Across a real sentence, that reads as
 * the mouth being stuck open almost continuously rather than flapping --
 * this bookended version guarantees a visible close on every word,
 * regardless of vowel count, while still giving vowel-heavier words more
 * flaps than short ones.
 */
export function computeMouthShapeIdForWord(word: string, progress01: number): string {
  const clampedProgress01 = Math.min(Math.max(progress01, 0), 1);
  const vowelSegments = countVowelSegments(word);
  const slotCount = 2 * vowelSegments + 1;
  const slotIndex = Math.min(Math.floor(clampedProgress01 * slotCount), slotCount - 1);
  return slotIndex % 2 === 0 ? "closed" : "open";
}

// How long one "blink cycle" lasts, and how much of it is actually spent
// with the eyes closed -- mirrors lookAround's own fixed-duration-segment +
// seeded-random-decision pattern above (computeLookAroundRotation) rather
// than a genuinely variable inter-blink gap, which wouldn't be a pure O(1)
// function of elapsed time the way every other seeded animation in this
// engine is. Exactly one blink happens per segment, at a jittered onset --
// never zero, so this reads as a steady, mildly varied blink rate rather
// than a fixed metronome tick.
const BLINK_SEGMENT_DURATION_SECONDS = 4.5;
const BLINK_DURATION_SECONDS = 0.12;

/** The fraction (0..1) into one blink segment where THAT segment's blink
 * starts -- a pure function of (seed, segmentIndex), same
 * hash-then-PRNG pair as lookAroundTargetRotation. Capped to leave room for
 * the blink's own short duration to complete before the segment ends. */
function blinkOnsetFraction(seed: number, segmentIndex: number): number {
  const random = mulberry32(ambientEffectSeed(`${seed}:blink:${segmentIndex}`));
  return random() * (1 - BLINK_DURATION_SECONDS / BLINK_SEGMENT_DURATION_SECONDS);
}

/**
 * Which "eyes" shape ("eyeOpen"/"eyeClosed" -- named to avoid colliding with
 * "mouth"'s own "open"/"closed" shapeIds in the same flat atlas namespace,
 * see skin.ts's own doc comment) should be drawn right now -- a steady idle
 * blink, independent of mood/mouth/gesture. Forced fully closed throughout
 * the "sleep" action (no randomized blinking while asleep); every other
 * action blinks on the fixed segment schedule above regardless of posture.
 */
export function computeEyeShapeId(actionId: string, elapsedSeconds: number, seed: number): string {
  if (actionId === "sleep") return "eyeClosed";

  const clampedElapsed = Math.max(0, elapsedSeconds);
  const segmentIndex = Math.floor(clampedElapsed / BLINK_SEGMENT_DURATION_SECONDS);
  const segmentPhase = clampedElapsed / BLINK_SEGMENT_DURATION_SECONDS - segmentIndex;
  const onsetFraction = blinkOnsetFraction(seed, segmentIndex);
  const blinkDurationFraction = BLINK_DURATION_SECONDS / BLINK_SEGMENT_DURATION_SECONDS;
  const isBlinking = segmentPhase >= onsetFraction && segmentPhase < onsetFraction + blinkDurationFraction;
  return isBlinking ? "eyeClosed" : "eyeOpen";
}
