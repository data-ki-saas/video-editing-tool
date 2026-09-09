/**
 * The entrance/exit catalog for a Text Slide (see video_math.ts's
 * SequenceEntry "text" variant) -- a slide's OWN self-contained animation as
 * it starts and ends, distinct from cutTransitionPresets.ts's
 * cutTransitionInId (which crossfades between two decoded video/image
 * SOURCES at a clip boundary). A text slide has no such source -- its
 * content is drawn fresh each frame (see textSlideRenderer.ts) -- so this is
 * a simple translate/opacity transform applied to the whole slide's own
 * draw call, computed purely from how far into its own entrance/exit window
 * the current frame is. Deliberately does not touch cutTransitionInId; the
 * entries before/after a text slide can still carry their own independent
 * blended-cut transition if a creator wants one at the hard cut too.
 *
 * Same closed-id-union + fixed-duration-no-knobs shape as
 * cutTransitionPresets.ts. One catalog, reused for BOTH entranceId ("enters
 * from...") and exitId ("exits toward...") -- same directional-value-reused-
 * contextually convention as imageTemplates.ts's pan-left/right/up/down ids.
 */
import { easeInOut } from "./video_math";

export type TextSlideTransitionId = "none" | "fade" | "left" | "right" | "top" | "bottom";

export interface TextSlideTransitionOption {
  id: TextSlideTransitionId;
  name: string;
}

export const TEXT_SLIDE_TRANSITION_OPTIONS: TextSlideTransitionOption[] = [
  { id: "none", name: "None" },
  { id: "fade", name: "Fade" },
  { id: "left", name: "Left" },
  { id: "right", name: "Right" },
  { id: "top", name: "Top" },
  { id: "bottom", name: "Bottom" },
];

export function getTextSlideTransitionOption(id: TextSlideTransitionId | null | undefined): TextSlideTransitionOption {
  return TEXT_SLIDE_TRANSITION_OPTIONS.find((option) => option.id === id) ?? TEXT_SLIDE_TRANSITION_OPTIONS[0];
}

// How long the entrance/exit animation itself takes -- fixed, no exposed
// knob, same "smart default over a knob" reasoning as
// CUT_TRANSITION_DURATION_SECONDS.
export const TEXT_SLIDE_TRANSITION_DURATION_SECONDS = 0.4;

// Never let entrance+exit eat more than 80% of a very short slide -- leaves
// at least a brief hold in the middle rather than the two animations
// overlapping/fighting each other. Same "guarantee a settle beat" reasoning
// as camera3D.ts's MIN_EASE_OUT_FRACTION.
const MAX_TRANSITION_FRACTION_OF_DURATION = 0.4;

function resolveTransitionDurationSeconds(durationSeconds: number): number {
  return Math.min(TEXT_SLIDE_TRANSITION_DURATION_SECONDS, Math.max(0, durationSeconds * MAX_TRANSITION_FRACTION_OF_DURATION));
}

export interface TextSlideTransform {
  opacity: number;
  // Fractions of the slide's own destination rect width/height -- +1 means
  // "one full rect-width off to the right", matching CropRect's own
  // fraction-of-frame convention elsewhere in this module.
  translateXFraction: number;
  translateYFraction: number;
}

const IDENTITY_TRANSFORM: TextSlideTransform = { opacity: 1, translateXFraction: 0, translateYFraction: 0 };

/** A direction id's fully-off-screen offset, at t=0 (t=1 is always back at
 * the identity 0,0). */
function offsetForDirection(id: TextSlideTransitionId): { x: number; y: number } {
  switch (id) {
    case "left":
      return { x: -1, y: 0};
    case "right":
      return { x: 1, y: 0 };
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    default:
      return { x: 0, y: 0 };
  }
}

/**
 * The slide's own opacity/translate at `elapsedSeconds` into its own
 * duration -- called identically from CanvasPlayer.tsx's live preview and
 * exportTimeline.ts's offline export (same shared-pure-function convention
 * as computeEffectiveCropRect), so the two can never drift. Entrance and
 * exit each get their own window at the start/end of the slide's duration;
 * outside both windows this is just the identity (fully in place, fully
 * opaque).
 */
export function computeTextSlideTransform(
  entranceId: TextSlideTransitionId,
  exitId: TextSlideTransitionId,
  elapsedSeconds: number,
  durationSeconds: number
): TextSlideTransform {
  const transitionDurationSeconds = resolveTransitionDurationSeconds(durationSeconds);
  if (transitionDurationSeconds <= 0) return IDENTITY_TRANSFORM;

  if (entranceId !== "none" && elapsedSeconds < transitionDurationSeconds) {
    const t = easeInOut(elapsedSeconds / transitionDurationSeconds);
    if (entranceId === "fade") return { opacity: t, translateXFraction: 0, translateYFraction: 0 };
    const offset = offsetForDirection(entranceId);
    return { opacity: 1, translateXFraction: offset.x * (1 - t), translateYFraction: offset.y * (1 - t) };
  }

  const exitStartSeconds = durationSeconds - transitionDurationSeconds;
  if (exitId !== "none" && elapsedSeconds > exitStartSeconds) {
    const t = easeInOut((elapsedSeconds - exitStartSeconds) / transitionDurationSeconds);
    if (exitId === "fade") return { opacity: 1 - t, translateXFraction: 0, translateYFraction: 0 };
    const offset = offsetForDirection(exitId);
    return { opacity: 1, translateXFraction: offset.x * t, translateYFraction: offset.y * t };
  }

  return IDENTITY_TRANSFORM;
}
