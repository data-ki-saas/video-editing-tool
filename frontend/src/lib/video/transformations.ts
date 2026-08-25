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
  isExclusiveLayout,
  FULL_FRAME_CROP_RECT,
  DEFAULT_TEXT_OVERLAY_RECT,
  DEFAULT_TRANSCRIPT_CAPTION_RECT,
  DEFAULT_OVERLAY_FRAMING,
  DEFAULT_SPLIT_SCREEN_RATIO,
  type CropRect,
  type OverlayFraming,
  type OverlayImage,
  type SequenceEntry,
  type TextOverlay,
  type VideoOverlayClip,
  type VideoOverlayLayout,
  type ZoomEffect,
} from "./video_math";
import { buildKenBurnsEffect } from "./imageTemplates";

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
  const newEntry: SequenceEntry = { id: crypto.randomUUID(), kind: "video", assetId };
  return {
    label: "Added clip to sequence",
    state: { ...selections, sequenceClips: [...selections.sequenceClips, newEntry] },
  };
}

// A freshly-added image clip defaults to this long -- long enough to read
// as a deliberate beat in the reel, short enough that a creator adding
// several photos in a row doesn't end up with a sluggish sequence. Also the
// floor/ceiling for ImageTemplatesDialog's duration stretch handle and
// FrameStrip's post-add resize handle (see applyResizeImageClip below).
export const DEFAULT_IMAGE_CLIP_DURATION_SECONDS = 4;
export const MIN_IMAGE_CLIP_DURATION_SECONDS = 1;
export const MAX_IMAGE_CLIP_DURATION_SECONDS = 15;

/** Appends an image asset to the concatenated sequence as its own
 * full-screen clip, animated via a Ken Burns template -- from
 * ImageTemplatesDialog's "Add to video". Unlike a video clip, this needs an
 * authored duration (images have none intrinsically) and generates its own
 * ZoomEffect from the chosen template (lib/video/imageTemplates.ts) up
 * front, both landing in ONE history entry -- "added...as a group," a
 * single undo step for the clip and its motion together. `startTimeSeconds`
 * is the sequence's current total duration (the caller already tracks this
 * as videoDurationSeconds), so the new clip lands after whatever's already
 * there, same "always appends" policy as applyAddSequenceClip. */
export function applyAddImageSequenceClip(
  selections: EditSelectionsSnapshot,
  assetId: string,
  durationSeconds: number,
  templateId: string,
  startTimeSeconds: number
): TransformationResult {
  const newEntry: SequenceEntry = { id: crypto.randomUUID(), kind: "image", assetId, durationSeconds, templateId };
  const base = selections.cropRect ?? FULL_FRAME_CROP_RECT;
  const newZoomEffect = buildKenBurnsEffect(templateId, base, startTimeSeconds, durationSeconds);
  return {
    label: "Added image clip",
    state: {
      ...selections,
      sequenceClips: [...selections.sequenceClips, newEntry],
      zoomEffects: [...selections.zoomEffects, newZoomEffect],
    },
  };
}

/** Resizing an image clip's duration from its own drag handle on
 * FrameStrip's clip-boundary marker (post-add, on the main timeline --
 * distinct from ImageTemplatesDialog's own duration stretch/+/- control,
 * which only sets the duration a clip is FIRST added with). Rescales the
 * clip's own Ken Burns ZoomEffect to still span exactly its new duration
 * (same start, epicenter/end pushed to the new end) and shifts every
 * later clip's own time-ranged state (zoom effects, overlays, text,
 * flip toggles, trims -- all authored in absolute elapsed-seconds across
 * the whole sequence) by the resulting delta, so nothing after this clip
 * silently drifts out of sync with its own footage.
 *
 * `clipStartSeconds` is passed in by the caller (ThreePaneEditor already
 * has it on the resolved SequenceClipInfo for this entry) rather than
 * recomputed here: a preceding VIDEO clip's real duration is only ever
 * known from the probed file, never stored on its SequenceEntry, so this
 * module -- which only ever sees `selections`, not probed durations --
 * can't derive it correctly on its own for a mixed video+image sequence. */
export function applyResizeImageClip(
  selections: EditSelectionsSnapshot,
  entryId: string,
  newDurationSeconds: number,
  clipStartSeconds: number
): TransformationResult {
  const entryIndex = selections.sequenceClips.findIndex((entry) => entry.id === entryId);
  const entry = selections.sequenceClips[entryIndex];
  if (!entry || entry.kind !== "image") return { label: "Resized image clip", state: selections };

  const clampedDuration = Math.min(
    MAX_IMAGE_CLIP_DURATION_SECONDS,
    Math.max(MIN_IMAGE_CLIP_DURATION_SECONDS, newDurationSeconds)
  );
  const delta = clampedDuration - entry.durationSeconds;
  if (delta === 0) return { label: "Resized image clip", state: selections };

  const shiftEffectRange = <T extends { startTimeSeconds: number; endTimeSeconds: number }>(item: T): T =>
    item.startTimeSeconds >= clipStartSeconds + entry.durationSeconds
      ? { ...item, startTimeSeconds: item.startTimeSeconds + delta, endTimeSeconds: item.endTimeSeconds + delta }
      : item;

  const nextEntries = [...selections.sequenceClips];
  nextEntries[entryIndex] = { ...entry, durationSeconds: clampedDuration };

  const nextZoomEffects = selections.zoomEffects.map((effect) => {
    if (effect.startTimeSeconds === clipStartSeconds && effect.endTimeSeconds === clipStartSeconds + entry.durationSeconds) {
      const newEnd = clipStartSeconds + clampedDuration;
      return { ...effect, epicenterTimeSeconds: newEnd, endTimeSeconds: newEnd };
    }
    return shiftEffectRange(effect);
  });

  return {
    label: "Resized image clip",
    state: {
      ...selections,
      sequenceClips: nextEntries,
      zoomEffects: nextZoomEffects,
      overlayImages: selections.overlayImages.map(shiftEffectRange),
      textOverlays: selections.textOverlays.map(shiftEffectRange),
      trimRanges: selections.trimRanges.map(shiftEffectRange),
      flipHorizontalToggles: selections.flipHorizontalToggles.map((t) => (t >= clipStartSeconds + entry.durationSeconds ? t + delta : t)),
      flipVerticalToggles: selections.flipVerticalToggles.map((t) => (t >= clipStartSeconds + entry.durationSeconds ? t + delta : t)),
    },
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

// Default window for a freshly-placed video overlay -- same "modest,
// clearly-adjustable" sizing rationale as DEFAULT_OVERLAY_DURATION_SECONDS.
export const DEFAULT_VIDEO_OVERLAY_DURATION_SECONDS = 3;
// A freshly-switched Picture-in-Picture box's starting position/size --
// bottom-right corner, a modest fraction of the frame. Only a starting
// point: the reused OverlayRectOverlay drag handles let the user move AND
// resize it afterward (see video_math.ts's VideoOverlayLayout doc comment).
export const DEFAULT_PIP_RECT: CropRect = { x: 0.64, y: 0.62, width: 0.32, height: 0.32 };

function overlapsExclusiveWindow(
  clips: VideoOverlayClip[],
  startTimeSeconds: number,
  endTimeSeconds: number,
  excludeIndex?: number
): boolean {
  return clips.some(
    (c, i) =>
      i !== excludeIndex &&
      isExclusiveLayout(c.layout) &&
      startTimeSeconds < c.endTimeSeconds &&
      endTimeSeconds > c.startTimeSeconds
  );
}

/** Adds a new video overlay at the current playhead, defaulting to
 * Full-Screen -- the "swap the visual" starting point, needing no further
 * setup like a rect or orientation. The user switches layout afterward via
 * VideoOverlayTrack's own right-click menu (applyChangeVideoOverlayLayout
 * below). If the playhead lands inside an existing EXCLUSIVE-layout overlay
 * (Full-Screen/Split-Screen), starts right after it instead of overlapping
 * -- a fresh overlay always starts exclusive, so this check always applies.
 * `sourceDurationSeconds` caps the window so it never asks to play more of
 * the source than exists (the in-point is fixed at 0 for v1). */
export function applyAddVideoOverlay(
  selections: EditSelectionsSnapshot,
  assetId: string,
  sourceDurationSeconds: number,
  currentTimeSeconds: number,
  videoDurationSeconds: number
): TransformationResult {
  const overlays = selections.videoOverlays;
  const containing = overlays.find(
    (o) => isExclusiveLayout(o.layout) && currentTimeSeconds >= o.startTimeSeconds && currentTimeSeconds < o.endTimeSeconds
  );
  const startTimeSeconds = containing ? containing.endTimeSeconds : currentTimeSeconds;
  const nextExclusiveStart = overlays
    .filter((o) => isExclusiveLayout(o.layout) && o.startTimeSeconds >= startTimeSeconds)
    .reduce((min, o) => Math.min(min, o.startTimeSeconds), Infinity);
  const sourceCap = sourceDurationSeconds > 0 ? startTimeSeconds + sourceDurationSeconds : Infinity;
  const sequenceCap = videoDurationSeconds > startTimeSeconds ? videoDurationSeconds : Infinity;
  const maxEnd = Math.min(nextExclusiveStart, sourceCap, sequenceCap);
  const endTimeSeconds = Math.min(startTimeSeconds + DEFAULT_VIDEO_OVERLAY_DURATION_SECONDS, maxEnd);
  if (endTimeSeconds <= startTimeSeconds) return { label: "Added overlay", state: selections };

  const newOverlay: VideoOverlayClip = {
    assetId,
    startTimeSeconds,
    endTimeSeconds,
    sourceStartSeconds: 0,
    layout: { type: "full-screen" },
    framing: DEFAULT_OVERLAY_FRAMING,
    audioBalance: 0,
  };
  return { label: "Added overlay", state: { ...selections, videoOverlays: [...overlays, newOverlay] } };
}

/** Switches a placed overlay's layout in place -- Full-Screen, Picture-in-
 * Picture, or Split Screen (Side by Side / Top & Bottom, both directly
 * selectable from the right-click menu, not hidden behind a follow-up
 * toggle) -- from VideoOverlayTrack's right-click menu. Switching TO an
 * exclusive layout (Full-Screen/Split-Screen) needs a collision check
 * against every OTHER exclusive-layout overlay (switching away from
 * Picture-in-Picture loses its "floats over anything" immunity); switching
 * TO Picture-in-Picture never needs one. */
export function applyChangeVideoOverlayLayout(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  layoutType: VideoOverlayLayout["type"],
  splitScreenOrientation: "horizontal" | "vertical" = "horizontal"
): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  if (!overlay) return { label: "Changed overlay layout", state: selections };
  const layout: VideoOverlayLayout =
    layoutType === "full-screen"
      ? { type: "full-screen" }
      : layoutType === "picture-in-picture"
        ? { type: "picture-in-picture", rect: DEFAULT_PIP_RECT }
        : { type: "split-screen", orientation: splitScreenOrientation, partnerFirst: false, baseFraming: DEFAULT_OVERLAY_FRAMING, ratio: DEFAULT_SPLIT_SCREEN_RATIO };
  if (
    isExclusiveLayout(layout) &&
    overlapsExclusiveWindow(selections.videoOverlays, overlay.startTimeSeconds, overlay.endTimeSeconds, overlayIndex)
  ) {
    return { label: "Changed overlay layout", state: selections }; // no room -- no-op
  }
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = { ...overlay, layout };
  return { label: "Changed overlay layout", state: { ...selections, videoOverlays: nextOverlays } };
}

/** Toggles a Split Screen overlay between side-by-side and top-and-bottom --
 * from the small orientation icon on its own VideoOverlayTrack segment.
 * No-op for any other layout. */
export function applyToggleSplitScreenOrientation(selections: EditSelectionsSnapshot, overlayIndex: number): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  if (!overlay || overlay.layout.type !== "split-screen") return { label: "Changed split screen orientation", state: selections };
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = {
    ...overlay,
    layout: { ...overlay.layout, orientation: overlay.layout.orientation === "horizontal" ? "vertical" : "horizontal" },
  };
  return { label: "Changed split screen orientation", state: { ...selections, videoOverlays: nextOverlays } };
}

/** Swaps which half a Split Screen overlay's footage occupies -- from the
 * small swap icon on its own VideoOverlayTrack segment. No-op for any other
 * layout. */
export function applyToggleSplitScreenSides(selections: EditSelectionsSnapshot, overlayIndex: number): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  if (!overlay || overlay.layout.type !== "split-screen") return { label: "Swapped split screen sides", state: selections };
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = { ...overlay, layout: { ...overlay.layout, partnerFirst: !overlay.layout.partnerFirst } };
  return { label: "Swapped split screen sides", state: { ...selections, videoOverlays: nextOverlays } };
}

/** Moving/resizing a Picture-in-Picture overlay's box via the reused
 * OverlayRectOverlay drag handles on FrameStrip's active tile -- position
 * only for any other layout is a no-op (nothing else has a rect to move). */
export function applyVideoOverlayRectChange(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  rect: CropRect
): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  if (!overlay || overlay.layout.type !== "picture-in-picture") return { label: "Moved overlay", state: selections };
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = { ...overlay, layout: { ...overlay.layout, rect } };
  return { label: "Moved overlay", state: { ...selections, videoOverlays: nextOverlays } };
}

/** Dragging a video overlay's segment edges on VideoOverlayTrack -- trims
 * how much of the source plays. Clamping (neighbors -- only against other
 * EXCLUSIVE overlays when this one is exclusive, never against
 * Picture-in-Picture clips -- [0, videoDurationSeconds], and the source's
 * own duration) happens in the track's own drag math; this just commits
 * the result. */
export function applyVideoOverlayRangeChange(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  startTimeSeconds: number,
  endTimeSeconds: number
): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  if (!overlay) return { label: "Trimmed overlay", state: selections };
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = { ...overlay, startTimeSeconds, endTimeSeconds };
  return { label: "Trimmed overlay", state: { ...selections, videoOverlays: nextOverlays } };
}

/** Dragging the MIDDLE of a video overlay's segment on VideoOverlayTrack --
 * slides the whole block along the timeline, keeping duration and source
 * in-point both fixed. */
export function applyVideoOverlayPositionChange(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  startTimeSeconds: number
): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  if (!overlay) return { label: "Moved overlay", state: selections };
  const durationSeconds = overlay.endTimeSeconds - overlay.startTimeSeconds;
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = { ...overlay, startTimeSeconds, endTimeSeconds: startTimeSeconds + durationSeconds };
  return { label: "Moved overlay", state: { ...selections, videoOverlays: nextOverlays } };
}

/** Removes one video overlay outright -- from VideoOverlayTrack's "Remove
 * overlay" context menu entry. */
/** Saves everything VideoOverlayFramingDialog lets you fine-tune -- one
 * commit on "Save", not a live/commit split, since the dialog keeps its
 * own local draft state while open (same pattern as TextOverlayDialog/
 * TranscriptCaptionDialog) rather than touching history on every drag.
 * `baseFraming`/`ratio` are only meaningful (and only ever passed) for a
 * Split-Screen overlay, whose popup shows both halves plus their divider;
 * `rect` is only meaningful (and only ever passed) for a Picture-in-Picture
 * overlay, whose popup lets the box itself be resized/repositioned (see
 * applyVideoOverlayRectChange's own doc comment for the FrameStrip
 * equivalent of that same move/resize gesture); `audioBalance` duplicates
 * VideoOverlayAudioTrack's own rail so the mix can be tuned from inside the
 * same popup. All of it is saved together as one undo step rather than
 * several. */
export function applyChangeOverlayFraming(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  framing: OverlayFraming,
  options?: { baseFraming?: OverlayFraming; ratio?: number; audioBalance?: number; rect?: CropRect }
): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  if (!overlay) return { label: "Adjusted overlay framing", state: selections };
  const nextLayout: VideoOverlayLayout =
    overlay.layout.type === "split-screen"
      ? {
          ...overlay.layout,
          baseFraming: options?.baseFraming ?? overlay.layout.baseFraming,
          ratio: options?.ratio ?? overlay.layout.ratio,
        }
      : overlay.layout.type === "picture-in-picture"
        ? { ...overlay.layout, rect: options?.rect ?? overlay.layout.rect }
        : overlay.layout;
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = {
    ...overlay,
    framing,
    layout: nextLayout,
    audioBalance: options?.audioBalance ?? overlay.audioBalance,
  };
  return { label: "Adjusted overlay framing", state: { ...selections, videoOverlays: nextOverlays } };
}

/** Dragging the mix handle on VideoOverlayAudioTrack -- 0 (default) plays
 * only the base clip's own audio through this window, 1 only the
 * overlay's, in between mixes both at that fraction of their own volume
 * (see video_math.ts's VideoOverlayClip.audioBalance). */
export function applyChangeOverlayAudioBalance(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  audioBalance: number
): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  if (!overlay) return { label: "Adjusted overlay audio mix", state: selections };
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = { ...overlay, audioBalance: Math.min(Math.max(audioBalance, 0), 1) };
  return { label: "Adjusted overlay audio mix", state: { ...selections, videoOverlays: nextOverlays } };
}

export function applyDeleteVideoOverlay(selections: EditSelectionsSnapshot, overlayIndex: number): TransformationResult {
  if (!selections.videoOverlays[overlayIndex]) return { label: "Removed overlay", state: selections };
  return {
    label: "Removed overlay",
    state: { ...selections, videoOverlays: selections.videoOverlays.filter((_, index) => index !== overlayIndex) },
  };
}
