/**
 * Which posture action, gesture, gaze, mood, and mouth shape an avatar clip
 * should render at THIS instant -- the one place CanvasPlayer.tsx (live
 * preview) and exportTimeline.ts (local render) both call, so the two never
 * disagree. Before the layered-motion redesign this was `resolveAvatarTalkState`,
 * hand-duplicated byte-for-byte in both files (posture action + mouth shape
 * only); this module absorbs that same logic UNCHANGED (see
 * resolvePostureAndMouth below) and adds gesture/gaze/mood resolution on top,
 * in one place, so the added complexity never has to be kept in sync by hand
 * across two files again.
 *
 * Gesture/gaze/mood beats come from two sources, merged per layer:
 *  - the clip's OWN persisted gestureTimeline/gazeTimeline/moodTimeline
 *    (AvatarFramingDialog's generalized "Direct with AI").
 *  - tag-derived beats reconstructed fresh, every call, from whichever TTS
 *    overlay this clip is TIED to (resolveTiedNarration -- an explicit
 *    ttsOverlayId, or the legacy time-overlap heuristic for "Auto", see
 *    that field's own doc comment in video_math.ts) reading that overlay's
 *    own tagAnchors (avatar/tags.ts) -- never persisted onto the clip
 *    itself, so editing the narration's tags always changes what plays with
 *    no separate re-sync step.
 * Tag-derived beats win outright on overlap with a persisted beat in the
 * same layer -- an explicit `{angry}` in the script is a more direct
 * instruction than whatever the LLM director proposed for that stretch.
 */
import {
  computeActiveMoodBias,
  computeMouthShapeId,
  computeMouthShapeIdForWord,
  type AvatarLayerActivation,
} from "./actions";
import type { CompiledTopology } from "./compile";
import type { ActionCurveSpec } from "./topology";
import {
  findActiveWordIndex,
  resolveTiedNarration,
  ttsOverlayEndTimeSeconds,
  type AvatarOverlayClip,
  type ResolvedTagAnchor,
  type TtsOverlay,
} from "../video_math";

/** Clamps `value` into [0,1] -- guards a word-progress fraction against
 * floating-point edge cases right at a word's own start/end boundary (see
 * computeMouthShapeIdForWord's own doc comment in actions.ts). */
function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export interface AvatarRenderState {
  activation: AvatarLayerActivation;
  mouthShapeId: string;
  expressionBias: Record<string, number> | undefined;
  // Mood-driven discrete facial expression (eyebrows/eyes) -- keyed by
  // skin.ts expressionShapes partId, straight into renderer.ts's drawAvatar
  // `activeExpressionShapeIds` param. `undefined` (no mood active, or this
  // topology declares no moodExpressionShapes at all) means every such part
  // falls back to its own base atlas rect -- see
  // AvatarTopology.moodExpressionShapes's own doc comment for why that's
  // already the correct "neutral" default, not a gap needing a fallback
  // value here. Callers that also want blink (Phase 4's eye shape, driven by
  // elapsed time/action rather than mood) merge that in separately before
  // calling drawAvatar.
  expressionShapeIds: Record<string, string> | undefined;
  // Gesture-driven discrete hand pose (fist/open/pointing) -- keyed by
  // skin.ts expressionShapes partId ("handL"/"handR"), same mechanism/shape
  // as expressionShapeIds above (see topology.ts's own
  // gestureHandPoseShapeIds doc comment for why this is its own field rather
  // than folded into that one: it's keyed off the active GESTURE beat, not
  // the active mood beat, so the two can be active independently and must be
  // resolved from separate beat lists). `undefined` means every hand part
  // falls back to its own base atlas rect (the open-palm pose). Callers merge
  // this into the same map they pass drawAvatar as `activeExpressionShapeIds`
  // (CanvasPlayer.tsx/exportTimeline.ts already merge blink's eyeShapeId in
  // there too).
  handPoseShapeIds: Record<string, string> | undefined;
}

/** One resolved beat, normalized to a common shape regardless of whether it
 * came from the clip's own persisted timeline or a tag anchor -- `source`
 * is what lets findActiveBeat give tag-derived beats overlap priority. */
export interface ResolvedBeat {
  id: string;
  startMs: number;
  endMs: number;
  source: "persisted" | "tag" | "prosody";
}

// Who wins when beats in the same layer overlap: an explicit {tag} beats the
// director's persisted timeline, which beats the automatic punctuation-derived
// beats.
const SOURCE_RANK: Record<ResolvedBeat["source"], number> = { tag: 2, persisted: 1, prosody: 0 };

function findActiveBeat(beats: ResolvedBeat[], localElapsedMs: number): ResolvedBeat | undefined {
  const covering = beats.filter((beat) => localElapsedMs >= beat.startMs && localElapsedMs < beat.endMs);
  return covering.reduce<ResolvedBeat | undefined>(
    (best, beat) => (!best || SOURCE_RANK[beat.source] > SOURCE_RANK[best.source] ? beat : best),
    undefined
  );
}

/** Drops any beat that overlaps a higher-priority one in the same layer --
 * unlike findActiveBeat above (which only needs to pick a winner at one
 * instant), computeActiveMoodBias consumes a whole beat LIST (it reasons
 * about ease-in/ease-out around beat boundaries, not just "what's active
 * right now"), so the priority rule has to be applied to the list itself
 * before handing it over, not resolved instant-by-instant. */
function dropOutrankedBeats(beats: ResolvedBeat[]): ResolvedBeat[] {
  return beats.filter(
    (beat) =>
      !beats.some((other) => SOURCE_RANK[other.source] > SOURCE_RANK[beat.source] && beat.startMs < other.endMs && beat.endMs > other.startMs)
  );
}

// How long an automatic "!" mood beat lasts. Cut short if the next automatic
// beat in the same layer starts sooner.
const PROSODY_MOOD_BEAT_MS = 1200;

/** Automatic expression beats from the narration's own punctuation: a word
 * ending in "!" gets a brief "excited" mood, one ending in "?" a head tilt.
 * Punctuation isn't in wordTimings (the TTS boundary text drops it), so this
 * reads it from the script text, relying on the same assumption tags.ts makes:
 * whitespace-split script words line up 1:1 with wordTimings. If the counts
 * disagree (a stray "—" token, say) it returns nothing rather than misplace
 * emphasis. Only emits a beat for a mood/gaze this topology actually has. */
function prosodyBeats(
  narration: TtsOverlay,
  narrationOffsetMs: number,
  topology: CompiledTopology
): { gaze: ResolvedBeat[]; mood: ResolvedBeat[] } {
  const empty = { gaze: [], mood: [] };
  const tokens = narration.text.replace(/\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length !== narration.wordTimings.length) return empty;

  const hasExcited = !!topology.moodPresets?.excited;
  const tiltSpec = topology.gazes?.tiltHead;
  const gaze: ResolvedBeat[] = [];
  const mood: ResolvedBeat[] = [];

  tokens.forEach((token, index) => {
    const startMs = narrationOffsetMs + narration.wordTimings[index].startMs;
    if (hasExcited && /!["')\]]*$/.test(token)) {
      mood.push({ id: "excited", startMs, endMs: startMs + PROSODY_MOOD_BEAT_MS, source: "prosody" });
    } else if (tiltSpec && /\?["')\]]*$/.test(token)) {
      gaze.push({ id: "tiltHead", startMs, endMs: startMs + tiltSpec.periodSeconds * 1000, source: "prosody" });
    }
  });

  const clampToNext = (beats: ResolvedBeat[]) =>
    beats.map((beat, i) => (beats[i + 1] ? { ...beat, endMs: Math.min(beat.endMs, beats[i + 1].startMs) } : beat));
  return { gaze: clampToNext(gaze), mood: clampToNext(mood) };
}

// A tag anchor names only a TRIGGER instant (avatar/tags.ts has no concept of
// "how long should this last" -- see ResolvedTagAnchor's own doc comment in
// video_math.ts), so a beat's own duration is derived here: a gesture/gaze
// beat lasts exactly as long as that spec's own authored periodSeconds (it's
// a `loop: false` one-shot that eases back to rest once played through, see
// library.ts's own doc comment on GESTURES/GAZES), while a mood beat (which
// has no spec/duration of its own) gets a fixed window. Either way, a beat is
// capped short if the NEXT same-layer tag anchor starts before it would
// otherwise end, so two tag-derived beats in the same layer never overlap
// each other. Exported so AvatarFramingDialog's "Direct with AI" can build
// its own `lockedBeats` (the ranges the LLM director must steer around) from
// the SAME duration heuristic, rather than a second, possibly-drifting copy
// of "how long does a tag's effect last."
export const DEFAULT_MOOD_TAG_BEAT_MS = 2500;

/** `topology` only needs `gestures`/`gazes` -- a plain structural pick (not
 * `CompiledTopology` specifically) so this also accepts a raw, uncompiled
 * `AvatarTopology` (AvatarFramingDialog's own `resolvedEntry.topology`),
 * which declares those same two fields identically. */
export function tagAnchorsToBeats(
  anchors: ResolvedTagAnchor[] | undefined,
  layer: "gesture" | "gaze" | "mood",
  narrationOffsetMs: number,
  topology: { gestures?: Record<string, ActionCurveSpec>; gazes?: Record<string, ActionCurveSpec> }
): ResolvedBeat[] {
  if (!anchors) return [];
  const layerAnchors = anchors.filter((anchor) => anchor.layer === layer).sort((a, b) => a.triggerMs - b.triggerMs);

  return layerAnchors.map((anchor, index) => {
    const startMs = narrationOffsetMs + anchor.triggerMs;
    const specPeriodMs =
      layer === "gesture"
        ? (topology.gestures?.[anchor.id]?.periodSeconds ?? 0) * 1000
        : layer === "gaze"
          ? (topology.gazes?.[anchor.id]?.periodSeconds ?? 0) * 1000
          : 0;
    const naturalDurationMs = specPeriodMs > 0 ? specPeriodMs : DEFAULT_MOOD_TAG_BEAT_MS;
    const next = layerAnchors[index + 1];
    const maxDurationMs = next ? narrationOffsetMs + next.triggerMs - startMs : Infinity;
    return { id: anchor.id, startMs, endMs: startMs + Math.min(naturalDurationMs, maxDurationMs), source: "tag" as const };
  });
}

/** Everything resolveAvatarTalkState used to compute -- the clip's own
 * actionTimeline beat (if any covers this instant) wins outright for the
 * posture action; mouth shape stays independently word-driven whenever a
 * narration word is actively playing, regardless of which posture/gesture/
 * gaze/mood ends up active. See this module's own doc comment above for the
 * full precedence.
 *
 * Unlike before the multi-avatar tie (`AvatarOverlayClip.ttsOverlayId`,
 * video_math.ts), "is there a narration at all" is now resolved PER CLIP
 * (resolveTiedNarration) rather than by scanning every TtsOverlay in the
 * project for whichever happens to be active at this instant -- two avatars
 * on screen together, each tied to their own script, no longer fight over
 * `candidates[0]` of the same global list. A clip with no tie at all (an
 * explicit `ttsOverlayId: null`, or "Auto" finding nothing overlapping it)
 * just plays its own `defaultAction`, regardless of what any OTHER avatar's
 * narration is doing elsewhere in the timeline -- this is the "hang around"
 * case.
 */
function resolvePostureAndMouth(
  clip: AvatarOverlayClip,
  ttsOverlays: TtsOverlay[],
  sequenceTimeSeconds: number,
  localElapsed: number
): { postureActionId: string; mouthShapeId: string } {
  const tied = resolveTiedNarration(clip, ttsOverlays);
  const narration =
    tied && sequenceTimeSeconds >= tied.startTimeSeconds && sequenceTimeSeconds < ttsOverlayEndTimeSeconds(tied) ? tied : null;
  const wordIndex = narration ? findActiveWordIndex(narration, sequenceTimeSeconds) : -1;

  function wordMouthShapeId(): string | null {
    if (!narration || wordIndex < 0) return null;
    const word = narration.wordTimings[wordIndex];
    const relativeMs = (sequenceTimeSeconds - narration.startTimeSeconds) * 1000;
    const progress01 = clamp01((relativeMs - word.startMs) / Math.max(1, word.endMs - word.startMs));
    return computeMouthShapeIdForWord(word.word, progress01);
  }

  const localElapsedMs = localElapsed * 1000;
  const beat = clip.actionTimeline?.find((b) => localElapsedMs >= b.startMs && localElapsedMs < b.endMs);
  if (beat) {
    return { postureActionId: beat.action, mouthShapeId: wordMouthShapeId() ?? computeMouthShapeId(beat.action, localElapsed) };
  }

  if (!narration) {
    if (!tied) {
      return { postureActionId: clip.defaultAction, mouthShapeId: computeMouthShapeId(clip.defaultAction, localElapsed) };
    }
    return { postureActionId: "idle", mouthShapeId: computeMouthShapeId("idle", localElapsed) };
  }
  const talkPostureActionId = clip.defaultAction.startsWith("talk") ? clip.defaultAction : "talk";
  if (wordIndex < 0) {
    // A breath between two words of the same sentence isn't a change of
    // posture -- staying in talk here avoids flipping talk<->idle (different
    // loop periods) on every word gap. Mouth stays closed regardless.
    if (isShortGapBetweenWords(narration, sequenceTimeSeconds)) {
      return { postureActionId: talkPostureActionId, mouthShapeId: "closed" };
    }
    return { postureActionId: "idle", mouthShapeId: computeMouthShapeId("idle", localElapsed) };
  }
  return { postureActionId: talkPostureActionId, mouthShapeId: wordMouthShapeId()! };
}

// Pauses up to this long between two words keep the talking posture; longer
// ones (a deliberate beat, the end of a sentence) drop back to idle.
const TALK_GAP_HOLD_MS = 400;
// How long the cross-fade between two postures lasts, and the resolution at
// which resolvePostureBlend searches backward for when the change happened.
export const POSTURE_BLEND_SECONDS = 0.2;
const POSTURE_BLEND_PROBE_STEP_SECONDS = 0.02;

function isShortGapBetweenWords(narration: TtsOverlay, sequenceTimeSeconds: number): boolean {
  const relativeMs = (sequenceTimeSeconds - narration.startTimeSeconds) * 1000;
  let previousEndMs: number | undefined;
  let nextStartMs: number | undefined;
  for (const word of narration.wordTimings) {
    if (word.endMs <= relativeMs) previousEndMs = word.endMs;
    else if (word.startMs > relativeMs) {
      nextStartMs = word.startMs;
      break;
    }
  }
  return previousEndMs !== undefined && nextStartMs !== undefined && nextStartMs - previousEndMs <= TALK_GAP_HOLD_MS;
}

/** If the posture changed within the last POSTURE_BLEND_SECONDS, the posture
 * we're leaving and an eased 0..1 progress through the fade; otherwise
 * undefined. Found by re-resolving posture at earlier instants rather than
 * remembering the last frame, so it stays a pure function of time -- the live
 * preview and the seeked export loop agree at any instant. Costs one extra
 * resolve per frame when posture is steady. */
function resolvePostureBlend(
  clip: AvatarOverlayClip,
  ttsOverlays: TtsOverlay[],
  sequenceTimeSeconds: number,
  localElapsed: number,
  currentPostureActionId: string
): { previousPostureActionId: string; postureBlend: number } | undefined {
  if (localElapsed < POSTURE_BLEND_SECONDS) return undefined;
  const probe = (secondsAgo: number) =>
    resolvePostureAndMouth(clip, ttsOverlays, sequenceTimeSeconds - secondsAgo, localElapsed - secondsAgo).postureActionId;
  if (probe(POSTURE_BLEND_SECONDS) === currentPostureActionId) return undefined;

  const stepCount = Math.round(POSTURE_BLEND_SECONDS / POSTURE_BLEND_PROBE_STEP_SECONDS);
  for (let i = 1; i <= stepCount; i++) {
    const secondsAgo = i * POSTURE_BLEND_PROBE_STEP_SECONDS;
    const earlier = probe(secondsAgo);
    if (earlier === currentPostureActionId) continue;
    // The change landed somewhere in (secondsAgo - step, secondsAgo]; take the middle.
    const sinceChange = secondsAgo - POSTURE_BLEND_PROBE_STEP_SECONDS / 2;
    const t = clamp01(sinceChange / POSTURE_BLEND_SECONDS);
    return { previousPostureActionId: earlier, postureBlend: t * t * (3 - 2 * t) };
  }
  return undefined;
}

export function resolveAvatarRenderState(
  clip: AvatarOverlayClip,
  ttsOverlays: TtsOverlay[],
  compiledDesignExpressionBias: Record<string, number> | undefined,
  topology: CompiledTopology,
  sequenceTimeSeconds: number,
  localElapsed: number
): AvatarRenderState {
  const { postureActionId, mouthShapeId } = resolvePostureAndMouth(clip, ttsOverlays, sequenceTimeSeconds, localElapsed);

  const overlappingNarration = resolveTiedNarration(clip, ttsOverlays);
  // Tag anchors are authored relative to the NARRATION's own start
  // (ResolvedTagAnchor.triggerMs); every beat this resolver works with is
  // relative to the CLIP's own start (same convention actionTimeline already
  // uses) -- this is the one conversion between the two clocks.
  const narrationOffsetMs = overlappingNarration ? (overlappingNarration.startTimeSeconds - clip.startTimeSeconds) * 1000 : 0;
  const tagAnchors = overlappingNarration?.tagAnchors;

  const localElapsedMs = localElapsed * 1000;

  const prosody =
    overlappingNarration && clip.autoExpression !== false
      ? prosodyBeats(overlappingNarration, narrationOffsetMs, topology)
      : { gaze: [], mood: [] };

  const gestureBeats: ResolvedBeat[] = [
    ...(clip.gestureTimeline?.map((beat) => ({ id: beat.gestureId, startMs: beat.startMs, endMs: beat.endMs, source: "persisted" as const })) ?? []),
    ...tagAnchorsToBeats(tagAnchors, "gesture", narrationOffsetMs, topology),
  ];
  const gazeBeats: ResolvedBeat[] = [
    ...(clip.gazeTimeline?.map((beat) => ({ id: beat.gazeId, startMs: beat.startMs, endMs: beat.endMs, source: "persisted" as const })) ?? []),
    ...tagAnchorsToBeats(tagAnchors, "gaze", narrationOffsetMs, topology),
    ...prosody.gaze,
  ];
  const moodBeats: ResolvedBeat[] = [
    ...(clip.moodTimeline?.map((beat) => ({ id: beat.moodId, startMs: beat.startMs, endMs: beat.endMs, source: "persisted" as const })) ?? []),
    ...tagAnchorsToBeats(tagAnchors, "mood", narrationOffsetMs, topology),
    ...prosody.mood,
  ];

  const activeGesture = findActiveBeat(gestureBeats, localElapsedMs);
  const activeGaze = findActiveBeat(gazeBeats, localElapsedMs);

  const activation: AvatarLayerActivation = {
    postureActionId,
    ...resolvePostureBlend(clip, ttsOverlays, sequenceTimeSeconds, localElapsed, postureActionId),
    gesture: activeGesture
      ? {
          gestureId: activeGesture.id,
          elapsedSeconds: (localElapsedMs - activeGesture.startMs) / 1000,
          remainingSeconds: (activeGesture.endMs - localElapsedMs) / 1000,
        }
      : undefined,
    gaze: activeGaze
      ? {
          gazeId: activeGaze.id,
          elapsedSeconds: (localElapsedMs - activeGaze.startMs) / 1000,
          remainingSeconds: (activeGaze.endMs - localElapsedMs) / 1000,
        }
      : undefined,
  };

  const moodBiasInput = dropOutrankedBeats(moodBeats).map((beat) => ({ moodId: beat.id, startMs: beat.startMs, endMs: beat.endMs }));
  const moodBias = computeActiveMoodBias(topology.moodPresets, topology.expressionParams, moodBiasInput, localElapsedMs);
  const expressionBias = moodBias ? { ...compiledDesignExpressionBias, ...moodBias } : compiledDesignExpressionBias;

  // Discrete facial-expression shape pick -- unlike moodBias above, this
  // snaps (no ease-in/out): whichever mood beat covers THIS instant, if any,
  // directly names the active shape per part. No active beat -> undefined,
  // which renderer.ts's drawAvatar already treats as "use each part's own
  // base rect" (biped-simple's "eyebrows" base rect IS "neutral").
  const activeMoodBeat = moodBiasInput.find((beat) => localElapsedMs >= beat.startMs && localElapsedMs < beat.endMs);
  const expressionShapeIds = activeMoodBeat ? topology.moodExpressionShapes?.[activeMoodBeat.moodId] : undefined;

  // Same "snap, no ease" pick as expressionShapeIds above, but off the
  // active GESTURE beat rather than the active mood beat -- a gesture not
  // listed in gestureHandPoseShapeIds (or no gesture active at all) leaves
  // handPoseShapeIds undefined, which renderer.ts's drawAvatar already
  // treats as "use each hand's own base rect" (the open-palm pose).
  const handPoseShapeIds = activeGesture ? topology.gestureHandPoseShapeIds?.[activeGesture.id] : undefined;

  // Mood beats that declare a mouth override (e.g. "laugh" -> "laughOpen")
  // win over the word-driven mouthShapeId computed above -- same "snap, no
  // lerp" convention as expressionShapeIds. Every mood NOT listed in
  // moodMouthShapeIds (the vast majority) leaves mouthShapeId exactly as
  // resolvePostureAndMouth computed it, so lip-sync is unaffected.
  const moodMouthShapeId = activeMoodBeat ? topology.moodMouthShapeIds?.[activeMoodBeat.moodId] : undefined;

  // A mood's RESTING mouth (e.g. happy -> "smile") only replaces a mouth that
  // lip-sync already computed as "closed", so an open (talking) mouth is never
  // overridden and narration timing stays fully in charge while speaking.
  const moodRestMouthShapeId = activeMoodBeat && mouthShapeId === "closed" ? topology.moodRestMouthShapeIds?.[activeMoodBeat.moodId] : undefined;

  return { activation, mouthShapeId: moodMouthShapeId ?? moodRestMouthShapeId ?? mouthShapeId, expressionBias, expressionShapeIds, handPoseShapeIds };
}
