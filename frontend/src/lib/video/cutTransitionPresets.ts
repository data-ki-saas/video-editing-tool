/**
 * The blended-cut-transition catalog -- applied at a clip boundary in the
 * base sequence (SequenceEntry.cutTransitionInId, see video_math.ts). Named
 * "cutTransition" everywhere in this feature specifically to stay distinct
 * from this codebase's OTHER, older use of "transition" (the pan/zoom Ken
 * Burns effect -- see video_math.ts's ZoomEffect and transformations.ts's
 * own "transition" labels) -- the two are unrelated concepts that happen to
 * share an English word.
 *
 * Same "single source of truth" shape as filterPresets.ts: a closed id
 * union + a catalog for the UI, kept free of the `creatomate` SDK import so
 * this file stays safe to import from client components (CanvasPlayer,
 * FrameStrip, the picker dialog) -- the SDK-class mapping for the real
 * Creatomate render lives in compileCreatomateTimeline.ts itself (server-only,
 * same split filterPresets.ts's own module comment documents).
 *
 * No duration or direction knobs on purpose -- one fixed duration and one
 * fixed direction per type (smart defaults over exposing every knob, per
 * this project's driving vision for a casual-creator-facing editor).
 */
export type CutTransitionId = "fade" | "slide" | "wipe";

export const CUT_TRANSITION_DURATION_SECONDS = 0.5;

export interface CutTransitionOption {
  id: CutTransitionId;
  name: string;
}

export const CUT_TRANSITION_OPTIONS: CutTransitionOption[] = [
  { id: "fade", name: "Fade" },
  { id: "slide", name: "Slide" },
  { id: "wipe", name: "Wipe" },
];

export function getCutTransitionOption(id: CutTransitionId | null | undefined): CutTransitionOption | null {
  if (!id) return null;
  return CUT_TRANSITION_OPTIONS.find((option) => option.id === id) ?? null;
}
