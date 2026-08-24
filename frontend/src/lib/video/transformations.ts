/**
 * Centralizes the "given the current edit-selections state and a user
 * action, what should the new state be" decision logic for every
 * frame-affecting transformation (clip-rectangle placement, zoom/pan
 * transitions, flip/mirror, and whatever comes next -- trim, a distinct
 * future effect type). ThreePaneEditor calls these and pushes the result
 * through useEditHistory; it should never contain this decision logic
 * inline itself.
 *
 * This matters as a separate layer from video_math.ts: video_math.ts holds
 * pure geometry (how to build/interpolate/scale a CropRect, which of
 * several ZoomEffects is active at a given time), this module holds the
 * higher-level rules for how a user action maps onto that geometry given
 * whatever's already there -- e.g. a crop drag either starts a new
 * transition or reshapes an existing one's nearer endpoint, depending on
 * where the playhead is, and a new transition gets clamped so it never
 * overlaps one already on the clip (zoom/pan transitions are mutually
 * exclusive with each other -- they're the same effect type, just
 * combining size and position change to different degrees; a genuinely
 * different future effect type would get its own array and wouldn't need
 * to avoid overlapping this one).
 */
import type { EditSelectionsSnapshot } from "@/lib/projects";
import {
  computeMaxCoverageCropFraction,
  findActiveZoomEffectIndex,
  toggleFlipAt,
  mergeTrimRanges,
  DEFAULT_TEXT_OVERLAY_RECT,
  DEFAULT_TRANSCRIPT_CAPTION_RECT,
  type CropRect,
  type OverlayImage,
  type TextOverlay,
  type ZoomEffect,
} from "./video_math";

export const DEFAULT_ZOOM_DURATION_SECONDS = 2;

export interface TransformationResult {
  /** Human-readable label for the change-history entry (FeedbackArea). */
  label: string;
  state: EditSelectionsSnapshot;
}

/** Picking a clip-rectangle ratio always resets to a fresh max-coverage
 * crop and drops every zoom/pan effect -- a new ratio invalidates whatever
 * transitions were built on the old one's geometry. Flip state is
 * untouched -- it's an independent, uniform toggle, not tied to any one
 * ratio. */
export function applySelectClipRect(
  selections: EditSelectionsSnapshot,
  clipRectId: string,
  targetRatio: number,
  sourceAspectRatio: number
): TransformationResult {
  const cropRect = computeMaxCoverageCropFraction(sourceAspectRatio, targetRatio);
  return { label: `Clip rectangle: ${clipRectId}`, state: { ...selections, clipRectId, cropRect, zoomEffects: [] } };
}

/**
 * Commits a drag/resize made at `currentTimeSeconds` -- from either
 * CanvasPlayer's live preview or FrameStrip's active tile, both call this.
 * Three cases:
 *  1. Dragging inside an existing transition's time range reshapes
 *     whichever of its three keyframes (start, epicenter, or end) the
 *     playhead is nearest to, rather than creating a redundant second
 *     effect covering the same instant.
 *  2. Dragging outside every existing transition, with a base crop
 *     already set, creates a new one: this moment becomes the epicenter
 *     (the peak the drag reaches), spanning a default window on either
 *     side that eases in from the base rect and back out to it -- "I zoom
 *     in, then slowly zoom out back to normal." Its start is clamped so
 *     it can't reach back before whichever transition already ends
 *     closest to this point, keeping every transition mutually
 *     non-overlapping.
 *  3. No base crop yet (the very first placement) just sets it directly.
 */
export function applyCropRectCommit(
  selections: EditSelectionsSnapshot,
  currentTimeSeconds: number,
  nextRect: CropRect
): TransformationResult {
  const activeIndex = findActiveZoomEffectIndex(selections.zoomEffects, currentTimeSeconds);

  if (activeIndex !== -1) {
    const zoomEffect = selections.zoomEffects[activeIndex];
    const distanceToStart = currentTimeSeconds - zoomEffect.startTimeSeconds;
    const distanceToEpicenter = Math.abs(currentTimeSeconds - zoomEffect.epicenterTimeSeconds);
    const distanceToEnd = zoomEffect.endTimeSeconds - currentTimeSeconds;
    const nearest = Math.min(distanceToStart, distanceToEpicenter, distanceToEnd);

    let nextZoomEffect: ZoomEffect;
    if (nearest === distanceToEpicenter) {
      nextZoomEffect = { ...zoomEffect, epicenterRect: nextRect };
    } else if (nearest === distanceToStart) {
      nextZoomEffect = { ...zoomEffect, startRect: nextRect };
    } else {
      nextZoomEffect = { ...zoomEffect, endRect: nextRect };
    }
    const nextZoomEffects = [...selections.zoomEffects];
    nextZoomEffects[activeIndex] = nextZoomEffect;
    return { label: "Adjusted transition", state: { ...selections, zoomEffects: nextZoomEffects } };
  }

  if (!selections.cropRect) {
    return { label: "Placed clip rectangle", state: { ...selections, cropRect: nextRect } };
  }

  const epicenterTimeSeconds = currentTimeSeconds;
  const precedingEffectEnd = selections.zoomEffects
    .filter((effect) => effect.endTimeSeconds <= currentTimeSeconds)
    .reduce((latest, effect) => Math.max(latest, effect.endTimeSeconds), 0);
  const startTimeSeconds = Math.max(precedingEffectEnd, epicenterTimeSeconds - DEFAULT_ZOOM_DURATION_SECONDS);
  const endTimeSeconds = epicenterTimeSeconds + DEFAULT_ZOOM_DURATION_SECONDS;

  const newZoomEffect: ZoomEffect = {
    startTimeSeconds,
    epicenterTimeSeconds,
    endTimeSeconds,
    startRect: selections.cropRect,
    epicenterRect: nextRect,
    endRect: selections.cropRect,
  };
  return {
    label: "New transition",
    state: { ...selections, zoomEffects: [...selections.zoomEffects, newZoomEffect] },
  };
}

/** Toggles a flip axis at `currentTimeSeconds`, from CropRectOverlay's edge
 * handles on the active tile -- "Flip" (horizontal, left/right edges) or
 * "Mirror" (vertical, top/bottom edges). "Flip starts from the frame I
 * clicked" -- clicking again at a later frame toggles it back (see
 * video_math.ts's toggleFlipAt). Independent of zoomEffects (a rect
 * transition) and of the other axis -- both can be toggled at different
 * times on the same clip. */
export function applyFlipToggle(
  selections: EditSelectionsSnapshot,
  axis: "horizontal" | "vertical",
  currentTimeSeconds: number
): TransformationResult {
  if (axis === "horizontal") {
    return {
      label: "Flip",
      state: { ...selections, flipHorizontalToggles: toggleFlipAt(selections.flipHorizontalToggles, currentTimeSeconds) },
    };
  }
  return {
    label: "Mirror",
    state: { ...selections, flipVerticalToggles: toggleFlipAt(selections.flipVerticalToggles, currentTimeSeconds) },
  };
}

/** Prolonging/shortening one transition by dragging its
 * ZoomEffectsTrack segment's edges -- only that entry's time range
 * changes, its start/end rects are untouched. `effectIndex` identifies
 * which transition in the array is being resized. A longer half (start to
 * epicenter, or epicenter to end) means a slower ease through that half. */
export function applyZoomRangeChange(
  selections: EditSelectionsSnapshot,
  effectIndex: number,
  startTimeSeconds: number,
  endTimeSeconds: number
): TransformationResult {
  const zoomEffect = selections.zoomEffects[effectIndex];
  if (!zoomEffect) return { label: "Adjusted transition range", state: selections };
  const nextZoomEffects = [...selections.zoomEffects];
  nextZoomEffects[effectIndex] = { ...zoomEffect, startTimeSeconds, endTimeSeconds };
  return { label: "Adjusted transition range", state: { ...selections, zoomEffects: nextZoomEffects } };
}

/** Deletes one transition outright -- from the "Delete transition" context
 * menu on ZoomEffectsTrack's green epicenter dot. Everything outside its
 * time range simply reverts to showing the fixed clip rectangle, same as
 * always happens outside any transition's range. */
export function applyDeleteZoomEffect(selections: EditSelectionsSnapshot, effectIndex: number): TransformationResult {
  if (!selections.zoomEffects[effectIndex]) return { label: "Deleted transition", state: selections };
  return {
    label: "Deleted transition",
    state: { ...selections, zoomEffects: selections.zoomEffects.filter((_, index) => index !== effectIndex) },
  };
}

/** Moving a transition's epicenter -- the green dot on ZoomEffectsTrack --
 * along its own segment. Only epicenterTimeSeconds changes; the three
 * keyframe rects and the segment's own start/end times are untouched. The
 * dot's own drag math (ZoomEffectsTrack.tsx) keeps it from crossing either
 * edge, so this never needs to reclamp it against start/endTimeSeconds. */
export function applyZoomEpicenterChange(
  selections: EditSelectionsSnapshot,
  effectIndex: number,
  epicenterTimeSeconds: number
): TransformationResult {
  const zoomEffect = selections.zoomEffects[effectIndex];
  if (!zoomEffect) return { label: "Moved epicenter", state: selections };
  const nextZoomEffects = [...selections.zoomEffects];
  nextZoomEffects[effectIndex] = { ...zoomEffect, epicenterTimeSeconds };
  return { label: "Moved epicenter", state: { ...selections, zoomEffects: nextZoomEffects } };
}

// Two clicks on TrimTrack's gray line landing within this distance of each
// other count as "clicked the pending dot again" -- cancels it, instead of
// creating a near-zero-length trim nobody meant to place.
const TRIM_CLICK_CANCEL_EPSILON_SECONDS = 0.15;

export interface TrimClickResult {
  /** null when this click only placed or cancelled a pending dot --
   * nothing to push into history yet. */
  historyChange: TransformationResult | null;
  nextPendingTrimStartSeconds: number | null;
}

/**
 * Decision logic for TrimTrack's two-click gesture. The first click on the
 * gray line (no pending dot yet) just places one -- nothing committed
 * yet. A second click completes the range between the two points, in
 * whichever order they were clicked, and merges it into any trim range it
 * now overlaps (see mergeTrimRanges). A second click landing back on
 * almost the same spot as the first cancels the pending dot instead.
 */
export function applyTrimTrackClick(
  selections: EditSelectionsSnapshot,
  pendingTrimStartSeconds: number | null,
  clickTimeSeconds: number
): TrimClickResult {
  if (pendingTrimStartSeconds === null) {
    return { historyChange: null, nextPendingTrimStartSeconds: clickTimeSeconds };
  }

  if (Math.abs(clickTimeSeconds - pendingTrimStartSeconds) < TRIM_CLICK_CANCEL_EPSILON_SECONDS) {
    return { historyChange: null, nextPendingTrimStartSeconds: null };
  }

  const startTimeSeconds = Math.min(pendingTrimStartSeconds, clickTimeSeconds);
  const endTimeSeconds = Math.max(pendingTrimStartSeconds, clickTimeSeconds);
  const trimRanges = mergeTrimRanges([...selections.trimRanges, { startTimeSeconds, endTimeSeconds }]);
  return {
    historyChange: { label: "Trim", state: { ...selections, trimRanges } },
    nextPendingTrimStartSeconds: null,
  };
}

/** Removes one trim range outright -- from the "Remove trim" context menu
 * on TrimTrack's red segment. The cut section plays again afterward. */
export function applyDeleteTrimRange(selections: EditSelectionsSnapshot, rangeIndex: number): TransformationResult {
  if (!selections.trimRanges[rangeIndex]) return { label: "Removed trim", state: selections };
  return {
    label: "Removed trim",
    state: { ...selections, trimRanges: selections.trimRanges.filter((_, index) => index !== rangeIndex) },
  };
}

// Default window/placement for a freshly-added image overlay -- "drop it
// on the first frame" -- a modest, clearly-adjustable centered box, both
// tweaked afterward via OverlayRectOverlay's own handles and its segment
// on OverlayTrack.
const DEFAULT_OVERLAY_DURATION_SECONDS = 3;
const DEFAULT_OVERLAY_RECT: CropRect = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };

/** Adds a new image overlay starting at the first frame (time 0), from
 * AssetGallery's right-click "Add" action on an image asset. */
export function applyAddOverlayImage(
  selections: EditSelectionsSnapshot,
  assetId: string,
  videoDurationSeconds: number
): TransformationResult {
  const endTimeSeconds = Math.min(
    DEFAULT_OVERLAY_DURATION_SECONDS,
    videoDurationSeconds > 0 ? videoDurationSeconds : DEFAULT_OVERLAY_DURATION_SECONDS
  );
  const newOverlay: OverlayImage = { assetId, startTimeSeconds: 0, endTimeSeconds, rect: DEFAULT_OVERLAY_RECT };
  return {
    label: "Added image overlay",
    state: { ...selections, overlayImages: [...selections.overlayImages, newOverlay] },
  };
}

/** Moving/resizing an overlay's rect via its own drag handles on the
 * active tile (see OverlayRectOverlay.tsx). */
export function applyOverlayRectCommit(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  nextRect: CropRect
): TransformationResult {
  const overlay = selections.overlayImages[overlayIndex];
  if (!overlay) return { label: "Moved overlay", state: selections };
  const nextOverlays = [...selections.overlayImages];
  nextOverlays[overlayIndex] = { ...overlay, rect: nextRect };
  return { label: "Moved overlay", state: { ...selections, overlayImages: nextOverlays } };
}

/** Dragging an overlay's segment edges on OverlayTrack -- "how many
 * frames the image is visible for." */
export function applyOverlayRangeChange(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  startTimeSeconds: number,
  endTimeSeconds: number
): TransformationResult {
  const overlay = selections.overlayImages[overlayIndex];
  if (!overlay) return { label: "Adjusted overlay range", state: selections };
  const nextOverlays = [...selections.overlayImages];
  nextOverlays[overlayIndex] = { ...overlay, startTimeSeconds, endTimeSeconds };
  return { label: "Adjusted overlay range", state: { ...selections, overlayImages: nextOverlays } };
}

/** Removes one image overlay outright -- from the "Remove overlay"
 * context menu on OverlayTrack's segment. */
export function applyDeleteOverlayImage(
  selections: EditSelectionsSnapshot,
  overlayIndex: number
): TransformationResult {
  if (!selections.overlayImages[overlayIndex]) return { label: "Removed image overlay", state: selections };
  return {
    label: "Removed image overlay",
    state: { ...selections, overlayImages: selections.overlayImages.filter((_, index) => index !== overlayIndex) },
  };
}

/** Appends a video asset to the concatenated sequence -- from
 * AssetGallery's right-click "Add" on a video asset. The first "Add" is
 * what starts rendering frames at all; every later one plays right after
 * whatever's already in the sequence. Duplicates are allowed (the same
 * clip can appear twice), same policy as image overlays. */
export function applyAddSequenceClip(selections: EditSelectionsSnapshot, assetId: string): TransformationResult {
  return {
    label: "Added clip to sequence",
    state: { ...selections, sequenceAssetIds: [...selections.sequenceAssetIds, assetId] },
  };
}

// Default duration for a freshly-added text overlay. Unlike an image
// overlay's "always the first frame," a caption is added at whatever
// moment the playhead is on when the dialog opens -- captions are placed
// at a specific moment on purpose, not always the start. Its rect now
// comes from TextOverlayDialog itself (positioned live against the actual
// current frame), defaulting to DEFAULT_TEXT_OVERLAY_RECT (video_math.ts)
// only when the caller doesn't pass one.
const DEFAULT_TEXT_OVERLAY_DURATION_SECONDS = DEFAULT_OVERLAY_DURATION_SECONDS;

/** Adds a new text overlay starting at the current playhead position,
 * from TextOverlayDialog's "Add". */
export function applyAddTextOverlay(
  selections: EditSelectionsSnapshot,
  text: string,
  templateId: string,
  currentTimeSeconds: number,
  videoDurationSeconds: number,
  rect: CropRect = DEFAULT_TEXT_OVERLAY_RECT
): TransformationResult {
  const startTimeSeconds = currentTimeSeconds;
  const endTimeSeconds = Math.min(
    startTimeSeconds + DEFAULT_TEXT_OVERLAY_DURATION_SECONDS,
    videoDurationSeconds > startTimeSeconds ? videoDurationSeconds : startTimeSeconds + DEFAULT_TEXT_OVERLAY_DURATION_SECONDS
  );
  const newOverlay: TextOverlay = {
    text,
    templateId,
    startTimeSeconds,
    endTimeSeconds,
    rect,
  };
  return {
    label: "Added text",
    state: { ...selections, textOverlays: [...selections.textOverlays, newOverlay] },
  };
}

/** Changes an existing text overlay's wording/template/rect -- from
 * TextOverlayDialog's "Save", reopened via TextOverlayTrack's "Edit
 * text." Its time range is untouched (that's TextOverlayTrack's own drag
 * handles' job); rect is optional since a plain edit-in-place from the
 * dialog still repositions it live against the current frame. */
export function applyEditTextOverlay(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  text: string,
  templateId: string,
  rect?: CropRect
): TransformationResult {
  const overlay = selections.textOverlays[overlayIndex];
  if (!overlay) return { label: "Edited text", state: selections };
  const nextOverlays = [...selections.textOverlays];
  nextOverlays[overlayIndex] = { ...overlay, text, templateId, ...(rect ? { rect } : {}) };
  return { label: "Edited text", state: { ...selections, textOverlays: nextOverlays } };
}

/** Moving/resizing a text overlay's rect via its own drag handles on the
 * active tile (see TextOverlayCanvas.tsx). */
export function applyTextOverlayRectCommit(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  nextRect: CropRect
): TransformationResult {
  const overlay = selections.textOverlays[overlayIndex];
  if (!overlay) return { label: "Moved text", state: selections };
  const nextOverlays = [...selections.textOverlays];
  nextOverlays[overlayIndex] = { ...overlay, rect: nextRect };
  return { label: "Moved text", state: { ...selections, textOverlays: nextOverlays } };
}

/** Dragging a text overlay's segment edges on TextOverlayTrack -- "how
 * many frames it's visible for." */
export function applyTextOverlayRangeChange(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  startTimeSeconds: number,
  endTimeSeconds: number
): TransformationResult {
  const overlay = selections.textOverlays[overlayIndex];
  if (!overlay) return { label: "Adjusted text range", state: selections };
  const nextOverlays = [...selections.textOverlays];
  nextOverlays[overlayIndex] = { ...overlay, startTimeSeconds, endTimeSeconds };
  return { label: "Adjusted text range", state: { ...selections, textOverlays: nextOverlays } };
}

/** Removes one text overlay outright -- from the "Remove" context menu
 * on TextOverlayTrack's segment. */
export function applyDeleteTextOverlay(
  selections: EditSelectionsSnapshot,
  overlayIndex: number
): TransformationResult {
  if (!selections.textOverlays[overlayIndex]) return { label: "Removed text", state: selections };
  return {
    label: "Removed text",
    state: { ...selections, textOverlays: selections.textOverlays.filter((_, index) => index !== overlayIndex) },
  };
}

/** Turns on auto-generated (transcript) captions, from
 * TranscriptCaptionDialog's "Enable" -- see video_math.ts's
 * TranscriptCaption for why this is one config for the whole video rather
 * than a time-ranged list like textOverlays. */
export function applyEnableTranscriptCaption(
  selections: EditSelectionsSnapshot,
  templateId: string,
  rect: CropRect = DEFAULT_TRANSCRIPT_CAPTION_RECT
): TransformationResult {
  return {
    label: "Enabled auto-captions",
    state: { ...selections, transcriptCaption: { templateId, rect } },
  };
}

/** Changes an already-enabled transcript caption's style/position, from
 * TranscriptCaptionDialog's "Update". No-op if it's been disabled since
 * the dialog opened. */
export function applyUpdateTranscriptCaption(
  selections: EditSelectionsSnapshot,
  templateId: string,
  rect: CropRect
): TransformationResult {
  if (!selections.transcriptCaption) return { label: "Updated auto-captions", state: selections };
  return {
    label: "Updated auto-captions",
    state: { ...selections, transcriptCaption: { templateId, rect } },
  };
}

/** Turns auto-captions off outright -- from TranscriptCaptionDialog's
 * "Disable". */
export function applyDisableTranscriptCaption(selections: EditSelectionsSnapshot): TransformationResult {
  if (!selections.transcriptCaption) return { label: "Disabled auto-captions", state: selections };
  return { label: "Disabled auto-captions", state: { ...selections, transcriptCaption: null } };
}
