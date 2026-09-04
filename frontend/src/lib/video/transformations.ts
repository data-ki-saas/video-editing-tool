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
  DEFAULT_TEXT_OVERLAY_RECT,
  DEFAULT_TRANSCRIPT_CAPTION_RECT,
  DEFAULT_OVERLAY_FRAMING,
  DEFAULT_SPLIT_SCREEN_RATIO,
  MIN_VIDEO_OVERLAY_DURATION_SECONDS,
  type BackgroundRemovalState,
  type CropRect,
  type ImageOverlayClip,
  type OverlayFraming,
  type SequenceEntry,
  type TextOverlay,
  type TtsOverlay,
  type VideoOverlayClip,
  type VideoOverlayLayout,
  type ZoomEffect,
} from "./video_math";
import { buildKenBurnsEffect } from "./imageTemplates";
import { getFilterPresetOption, type FilterPresetId } from "./filterPresets";
import { getCutTransitionOption, type CutTransitionId } from "./cutTransitionPresets";
import { getCanvasFillOption, type CanvasFillMode } from "./canvasFillPresets";
import type { AmbientEffectId } from "./ambientEffects";

export const DEFAULT_ZOOM_DURATION_SECONDS = 2;

export interface TransformationResult {
  /** Human-readable label for the change-history entry (FeedbackArea). */
  label: string;
  state: EditSelectionsSnapshot;
}

/** Picking a clip-rectangle ratio always resets to a fresh max-coverage
 * crop for the single base clip. Its own zoom/pan effects get dropped too
 * -- a new ratio invalidates whatever transitions were built on that base
 * rect's old geometry -- but ONLY when there's no sequence yet
 * (sequenceClips.length === 0): once a sequence exists, `zoomEffects` also
 * holds each image clip's own Ken Burns motion (applyAddImageSequenceClip),
 * each built from THAT clip's own cropRect (stored on the SequenceEntry
 * itself, untouched by this), not the base rect's ratio at all -- those
 * stay geometrically valid regardless of what the overall clip rectangle
 * changes to, so wiping the whole array here used to silently delete every
 * photo's Ken Burns animation (including every one a niche wizard
 * auto-assembled) the first time someone picked a clip rectangle
 * afterward. Flip state is untouched either way -- it's an independent,
 * uniform toggle, not tied to any one ratio. */
export function applySelectClipRect(
  selections: EditSelectionsSnapshot,
  clipRectId: string,
  targetRatio: number,
  sourceAspectRatio: number
): TransformationResult {
  const cropRect = computeMaxCoverageCropFraction(sourceAspectRatio, targetRatio);
  const zoomEffects = selections.sequenceClips.length === 0 ? [] : selections.zoomEffects;
  return { label: `Clip rectangle: ${clipRectId}`, state: { ...selections, clipRectId, cropRect, zoomEffects } };
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

/** Deletes one flip segment outright -- from the "Delete flip"/"Delete
 * mirror" context menu on FlipTrack's colored segment, the direct-
 * manipulation undo for a flip toggle that's otherwise only reachable by
 * re-clicking the same crop-rectangle edge handle at the exact frame it was
 * set on. Removes the pair of toggles that bound the segment (or just its
 * lone leading toggle, if the segment runs to the clip's end with no
 * closing toggle yet) -- video_math.ts's computeFlipSegments pairs the same
 * sorted toggle list into segments in this same order, so segmentIndex here
 * always lines up with the segment the user right-clicked. */
export function applyDeleteFlipSegment(
  selections: EditSelectionsSnapshot,
  axis: "horizontal" | "vertical",
  segmentIndex: number
): TransformationResult {
  const label = axis === "horizontal" ? "Deleted flip" : "Deleted mirror";
  const toggles = axis === "horizontal" ? selections.flipHorizontalToggles : selections.flipVerticalToggles;
  const sorted = [...toggles].sort((a, b) => a - b);
  const pair = sorted.slice(segmentIndex * 2, segmentIndex * 2 + 2);
  if (pair.length === 0) return { label, state: selections };
  const nextToggles = toggles.filter((t) => !pair.includes(t));
  return {
    label,
    state:
      axis === "horizontal"
        ? { ...selections, flipHorizontalToggles: nextToggles }
        : { ...selections, flipVerticalToggles: nextToggles },
  };
}

/** Picking a color filter preset (or "none") for one specific cutaway
 * (base-sequence clip, video or image) from FilterPresetDialog -- id-based,
 * same selections.sequenceClips.findIndex(...) lookup as
 * applyEditImageSequenceClip/applyDeleteSequenceClip, since the same asset
 * can appear more than once (each placement needs its own filter). */
export function applySelectCutawayFilterPreset(
  selections: EditSelectionsSnapshot,
  entryId: string,
  filterId: FilterPresetId
): TransformationResult {
  const entryIndex = selections.sequenceClips.findIndex((entry) => entry.id === entryId);
  const entry = selections.sequenceClips[entryIndex];
  const label = `Cutaway filter: ${getFilterPresetOption(filterId === "none" ? null : filterId).name}`;
  if (!entry) return { label, state: selections };
  const nextEntries = [...selections.sequenceClips];
  nextEntries[entryIndex] = { ...entry, colorFilterId: filterId === "none" ? null : filterId };
  return { label, state: { ...selections, sequenceClips: nextEntries } };
}

/** Picking a canvas fill mode (Blur/Solid Color/Gradient/Crop to Fill) for
 * one specific cutaway from CanvasFillDialog -- same id-based
 * selections.sequenceClips.findIndex(...) lookup as
 * applySelectCutawayFilterPreset immediately above. `colors` is only ever
 * passed for "solid"/"gradient" (the color picker(s) that mode's own
 * dialog panel reveals) and left undefined otherwise, so picking Blur/Crop
 * after previously picking Solid/Gradient doesn't need its own separate
 * "clear the color" action -- the color fields simply go unused again
 * whenever mode isn't "solid"/"gradient" (see canvasFillPresets.ts/
 * compileCreatomateTimeline.ts, which both only ever read them in that
 * case). */
export function applySelectCanvasFillMode(
  selections: EditSelectionsSnapshot,
  entryId: string,
  mode: CanvasFillMode,
  colors?: { color?: string; gradientColor?: string }
): TransformationResult {
  const entryIndex = selections.sequenceClips.findIndex((entry) => entry.id === entryId);
  const entry = selections.sequenceClips[entryIndex];
  const label = `Canvas fill: ${getCanvasFillOption(mode).name}`;
  if (!entry) return { label, state: selections };
  const nextEntries = [...selections.sequenceClips];
  nextEntries[entryIndex] = {
    ...entry,
    canvasFillMode: mode === "crop" ? null : mode,
    ...(colors?.color !== undefined ? { canvasFillColor: colors.color } : {}),
    ...(colors?.gradientColor !== undefined ? { canvasFillGradientColor: colors.gradientColor } : {}),
  };
  return { label, state: { ...selections, sequenceClips: nextEntries } };
}

/** Picking a cut-transition (or "cut," i.e. none) for the boundary INTO one
 * specific base-sequence clip from whichever clip precedes it -- same
 * id-based lookup/shape as applySelectCutawayFilterPreset immediately
 * above. Named "cutTransition" to stay distinct from this file's OWN,
 * older "transition" (the pan/zoom Ken Burns effect) -- see
 * video_math.ts's SequenceEntry.cutTransitionInId doc comment. */
export function applySelectClipTransition(
  selections: EditSelectionsSnapshot,
  entryId: string,
  cutTransitionId: CutTransitionId | null
): TransformationResult {
  const entryIndex = selections.sequenceClips.findIndex((entry) => entry.id === entryId);
  const entry = selections.sequenceClips[entryIndex];
  const label = `Transition: ${getCutTransitionOption(cutTransitionId)?.name ?? "Cut"}`;
  if (!entry) return { label, state: selections };
  const nextEntries = [...selections.sequenceClips];
  nextEntries[entryIndex] = { ...entry, cutTransitionInId: cutTransitionId };
  return { label, state: { ...selections, sequenceClips: nextEntries } };
}

/** Same as applySelectCutawayFilterPreset, for one placed image overlay --
 * index-based, same shape as applyChangeImageOverlayLayout. */
export function applySelectImageOverlayFilterPreset(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  filterId: FilterPresetId
): TransformationResult {
  const overlay = selections.overlayImages[overlayIndex];
  const label = `Overlay filter: ${getFilterPresetOption(filterId === "none" ? null : filterId).name}`;
  if (!overlay) return { label, state: selections };
  const nextOverlays = [...selections.overlayImages];
  nextOverlays[overlayIndex] = { ...overlay, colorFilterId: filterId === "none" ? null : filterId };
  return { label, state: { ...selections, overlayImages: nextOverlays } };
}

/** Same as applySelectImageOverlayFilterPreset, for one placed video overlay. */
export function applySelectVideoOverlayFilterPreset(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  filterId: FilterPresetId
): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  const label = `Overlay filter: ${getFilterPresetOption(filterId === "none" ? null : filterId).name}`;
  if (!overlay) return { label, state: selections };
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = { ...overlay, colorFilterId: filterId === "none" ? null : filterId };
  return { label, state: { ...selections, videoOverlays: nextOverlays } };
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

// Default window/placement for a freshly-added image overlay -- a modest,
// clearly-adjustable centered box (unlike a video overlay's default
// bottom-right DEFAULT_PIP_RECT below, chosen to match the position this
// feature already used before it grew a switchable layout, so existing
// muscle memory/screenshots don't shift).
const DEFAULT_OVERLAY_DURATION_SECONDS = 3;
const DEFAULT_OVERLAY_RECT: CropRect = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };

/** Adds a new image overlay at the current playhead, defaulting to
 * Picture-in-Picture at DEFAULT_OVERLAY_RECT -- from AssetGallery's
 * right-click "Overlay" action on an image asset, or the Image Overlay
 * tab's picker dialog. Mirrors applyAddVideoOverlay's shape (playhead-
 * anchored, switchable afterward) but skips its exclusive-window collision
 * check entirely: a fresh image overlay always starts as
 * Picture-in-Picture, which never collides with anything. */
export function applyAddImageOverlay(
  selections: EditSelectionsSnapshot,
  assetId: string,
  currentTimeSeconds: number,
  videoDurationSeconds: number
): TransformationResult {
  const startTimeSeconds = currentTimeSeconds;
  const endTimeSeconds = Math.min(
    startTimeSeconds + DEFAULT_OVERLAY_DURATION_SECONDS,
    videoDurationSeconds > startTimeSeconds ? videoDurationSeconds : startTimeSeconds + DEFAULT_OVERLAY_DURATION_SECONDS
  );
  if (endTimeSeconds <= startTimeSeconds) return { label: "Added image overlay", state: selections };
  const newOverlay: ImageOverlayClip = {
    assetId,
    startTimeSeconds,
    endTimeSeconds,
    layout: { type: "picture-in-picture", rect: DEFAULT_OVERLAY_RECT },
    framing: DEFAULT_OVERLAY_FRAMING,
  };
  return {
    label: "Added image overlay",
    state: { ...selections, overlayImages: [...selections.overlayImages, newOverlay] },
  };
}

/** Switches a placed image overlay's layout in place -- same three choices
 * and same exclusive-collision check (against every OTHER image overlay
 * only -- video overlays are a separate array/rail, see this file's own
 * z-order notes in CanvasPlayer.tsx) as applyChangeVideoOverlayLayout. */
export function applyChangeImageOverlayLayout(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  layoutType: VideoOverlayLayout["type"],
  splitScreenOrientation: "horizontal" | "vertical" = "horizontal"
): TransformationResult {
  const overlay = selections.overlayImages[overlayIndex];
  if (!overlay) return { label: "Changed overlay layout", state: selections };
  const layout: VideoOverlayLayout =
    layoutType === "full-screen"
      ? { type: "full-screen" }
      : layoutType === "picture-in-picture"
        ? { type: "picture-in-picture", rect: DEFAULT_OVERLAY_RECT }
        : { type: "split-screen", orientation: splitScreenOrientation, partnerFirst: false, baseFraming: DEFAULT_OVERLAY_FRAMING, ratio: DEFAULT_SPLIT_SCREEN_RATIO };
  if (
    isExclusiveLayout(layout) &&
    overlapsExclusiveWindow(selections.overlayImages, overlay.startTimeSeconds, overlay.endTimeSeconds, overlayIndex)
  ) {
    return { label: "Changed overlay layout", state: selections }; // no room -- no-op
  }
  const nextOverlays = [...selections.overlayImages];
  nextOverlays[overlayIndex] = { ...overlay, layout };
  return { label: "Changed overlay layout", state: { ...selections, overlayImages: nextOverlays } };
}

/** Toggles an image Split Screen overlay between side-by-side and
 * top-and-bottom -- mirrors applyToggleSplitScreenOrientation. */
export function applyToggleImageSplitScreenOrientation(selections: EditSelectionsSnapshot, overlayIndex: number): TransformationResult {
  const overlay = selections.overlayImages[overlayIndex];
  if (!overlay || overlay.layout.type !== "split-screen") return { label: "Changed split screen orientation", state: selections };
  const nextOverlays = [...selections.overlayImages];
  nextOverlays[overlayIndex] = {
    ...overlay,
    layout: { ...overlay.layout, orientation: overlay.layout.orientation === "horizontal" ? "vertical" : "horizontal" },
  };
  return { label: "Changed split screen orientation", state: { ...selections, overlayImages: nextOverlays } };
}

/** Swaps which half an image Split Screen overlay's photo occupies --
 * mirrors applyToggleSplitScreenSides. */
export function applyToggleImageSplitScreenSides(selections: EditSelectionsSnapshot, overlayIndex: number): TransformationResult {
  const overlay = selections.overlayImages[overlayIndex];
  if (!overlay || overlay.layout.type !== "split-screen") return { label: "Swapped split screen sides", state: selections };
  const nextOverlays = [...selections.overlayImages];
  nextOverlays[overlayIndex] = { ...overlay, layout: { ...overlay.layout, partnerFirst: !overlay.layout.partnerFirst } };
  return { label: "Swapped split screen sides", state: { ...selections, overlayImages: nextOverlays } };
}

/** Moving/resizing an image overlay's rect -- via the reused
 * OverlayRectOverlay drag handles on FrameStrip's active tile for a
 * Picture-in-Picture layout, same as applyVideoOverlayRectChange; a no-op
 * for any other layout (nothing else has a rect to move). */
export function applyImageOverlayRectChange(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  rect: CropRect
): TransformationResult {
  const overlay = selections.overlayImages[overlayIndex];
  if (!overlay || overlay.layout.type !== "picture-in-picture") return { label: "Moved overlay", state: selections };
  const nextOverlays = [...selections.overlayImages];
  nextOverlays[overlayIndex] = { ...overlay, layout: { ...overlay.layout, rect } };
  return { label: "Moved overlay", state: { ...selections, overlayImages: nextOverlays } };
}

/** Dragging an image overlay's segment edges on ImageOverlayTrack -- trims
 * its visible window. Clamping happens in the track's own drag math (same
 * convention as applyVideoOverlayRangeChange); this just commits the
 * result. */
export function applyImageOverlayRangeChange(
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

/** Dragging the MIDDLE of an image overlay's segment on ImageOverlayTrack --
 * slides the whole block along the timeline, duration fixed -- mirrors
 * applyVideoOverlayPositionChange. */
export function applyImageOverlayPositionChange(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  startTimeSeconds: number
): TransformationResult {
  const overlay = selections.overlayImages[overlayIndex];
  if (!overlay) return { label: "Moved overlay", state: selections };
  const durationSeconds = overlay.endTimeSeconds - overlay.startTimeSeconds;
  const nextOverlays = [...selections.overlayImages];
  nextOverlays[overlayIndex] = { ...overlay, startTimeSeconds, endTimeSeconds: startTimeSeconds + durationSeconds };
  return { label: "Moved overlay", state: { ...selections, overlayImages: nextOverlays } };
}

/** Saves everything ImageOverlayFramingDialog lets you fine-tune -- same
 * shape as applyChangeOverlayFraming, minus `audioBalance` (images have no
 * audio to mix). */
export function applyChangeImageOverlayFraming(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  framing: OverlayFraming,
  options?: {
    baseFraming?: OverlayFraming;
    ratio?: number;
    rect?: CropRect;
    camera3D?: boolean;
    ambientEffect?: AmbientEffectId | null;
    audioReactive?: boolean;
  }
): TransformationResult {
  const overlay = selections.overlayImages[overlayIndex];
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
  const nextOverlays = [...selections.overlayImages];
  nextOverlays[overlayIndex] = {
    ...overlay,
    framing,
    layout: nextLayout,
    camera3D: options?.camera3D ?? overlay.camera3D,
    ambientEffect: options?.ambientEffect ?? overlay.ambientEffect,
    audioReactive: options?.audioReactive ?? overlay.audioReactive,
  };
  return { label: "Adjusted overlay framing", state: { ...selections, overlayImages: nextOverlays } };
}

/** Removes one image overlay outright -- from ImageOverlayTrack's "Remove
 * overlay" context menu entry, or its framing dialog's "Remove Overlay". */
export function applyDeleteImageOverlay(
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
export function applyAddSequenceClip(
  selections: EditSelectionsSnapshot,
  assetId: string,
  removeBackground?: boolean
): TransformationResult {
  const newEntry: SequenceEntry = {
    id: crypto.randomUUID(),
    kind: "video",
    assetId,
    // matteAssetId starts null -- the caller (ThreePaneEditor's
    // handleAddToSequence) kicks off the actual matting job right after
    // this and patches it in later via applySetBackgroundRemoval once the
    // async job completes, same "waiting" staging as avatar generation.
    ...(removeBackground ? { backgroundRemoval: { enabled: true, matteAssetId: null } } : {}),
  };
  return {
    label: "Added clip to sequence",
    state: { ...selections, sequenceClips: [...selections.sequenceClips, newEntry] },
  };
}

/** Patches one cutaway's backgroundRemoval field in place -- used both by
 * ThreePaneEditor's request/poll flow to silently write in the real
 * matteAssetId once a matting job completes (no new undo step for that --
 * see pushChange callers' own comments on background-completion updates
 * not needing one), for either a video (VEED, async) or image (rembg,
 * synchronous) cutaway -- both SequenceEntry variants carry
 * backgroundRemoval (see video_math.ts's own doc comment). */
export function applySetBackgroundRemoval(
  selections: EditSelectionsSnapshot,
  entryId: string,
  backgroundRemoval: { enabled: boolean; matteAssetId?: string | null } | null
): TransformationResult {
  const entryIndex = selections.sequenceClips.findIndex((entry) => entry.id === entryId);
  const entry = selections.sequenceClips[entryIndex];
  const label = backgroundRemoval?.enabled ? "Remove background" : "Restore background";
  if (!entry) return { label, state: selections };
  const nextEntries = [...selections.sequenceClips];
  nextEntries[entryIndex] = { ...entry, backgroundRemoval };
  return { label, state: { ...selections, sequenceClips: nextEntries } };
}

// A freshly-added image clip defaults to this long -- long enough to read
// as a deliberate beat in the reel, short enough that a creator adding
// several photos in a row doesn't end up with a sluggish sequence. Also the
// floor/ceiling for CutawayDialog's duration stretch handle and
// FrameStrip's post-add resize handle (see applyResizeImageClip below).
export const DEFAULT_IMAGE_CLIP_DURATION_SECONDS = 4;
export const MIN_IMAGE_CLIP_DURATION_SECONDS = 1;
export const MAX_IMAGE_CLIP_DURATION_SECONDS = 15;

/** Appends an image asset to the concatenated sequence as its own
 * full-screen clip, animated via one or more combined Ken Burns templates --
 * from CutawayDialog's "Add to video". Unlike a video clip, this
 * needs an authored duration (images have none intrinsically), a
 * `cropRect` (the clip rectangle the user positioned specifically for THIS
 * photo in the dialog -- fractions of the photo, not the project's
 * video-frame `selections.cropRect`), and generates its own ZoomEffect from
 * the chosen template(s) (lib/video/imageTemplates.ts) up front, both
 * landing in ONE history entry -- "added...as a group," a single undo step
 * for the clip and its motion together. `startTimeSeconds` is the
 * sequence's current total duration (the caller already tracks this as
 * videoDurationSeconds), so the new clip lands after whatever's already
 * there, same "always appends" policy as applyAddSequenceClip. */
export function applyAddImageSequenceClip(
  selections: EditSelectionsSnapshot,
  assetId: string,
  durationSeconds: number,
  templateIds: string[],
  cropRect: CropRect,
  startTimeSeconds: number,
  removeBackground?: boolean,
  camera3D?: boolean,
  ambientEffect?: AmbientEffectId | null,
  audioReactive?: boolean
): TransformationResult {
  const newEntry: SequenceEntry = {
    id: crypto.randomUUID(),
    kind: "image",
    assetId,
    durationSeconds,
    templateIds,
    cropRect,
    // matteAssetId starts null -- same "instant add, patch in the real
    // result once the job completes" staging as applyAddSequenceClip's own
    // video-kind backgroundRemoval, except a photo's own matting job
    // (backend/src/matting/service.py's image-kind path) is synchronous,
    // so the caller (ThreePaneEditor) may patch this in almost immediately
    // rather than after a real poll loop.
    ...(removeBackground ? { backgroundRemoval: { enabled: true, matteAssetId: null } } : {}),
    camera3D,
    ambientEffect,
    audioReactive,
  };
  const newZoomEffect = buildKenBurnsEffect(templateIds, cropRect, startTimeSeconds, durationSeconds);
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
 * distinct from CutawayDialog's own duration stretch/+/- control,
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
      videoOverlays: selections.videoOverlays.map(shiftEffectRange),
      ttsOverlays: selections.ttsOverlays.map((overlay) =>
        overlay.startTimeSeconds >= clipStartSeconds + entry.durationSeconds
          ? { ...overlay, startTimeSeconds: overlay.startTimeSeconds + delta }
          : overlay
      ),
      flipHorizontalToggles: selections.flipHorizontalToggles.map((t) => (t >= clipStartSeconds + entry.durationSeconds ? t + delta : t)),
      flipVerticalToggles: selections.flipVerticalToggles.map((t) => (t >= clipStartSeconds + entry.durationSeconds ? t + delta : t)),
    },
  };
}

/** Changes an existing image cutaway's photo/animation/duration/crop in
 * place -- from CutawayDialog's "Save changes", reopened by clicking
 * a segment on the Cutaways rail (CutawayTrack.tsx). Reuses
 * applyResizeImageClip's own reflow logic for any duration change
 * (shifting every later timed thing by the resulting delta), then always
 * rebuilds the clip's own ZoomEffect from scratch via buildKenBurnsEffect
 * rather than end-shifting the old one like applyResizeImageClip does --
 * unlike a plain resize, the photo/template(s)/crop can all change too, so
 * the old effect's start/target rects can't just be reused. Builds the
 * replacement entry as an explicit object, not `{ ...entry, ... }` --
 * `entry` may still carry a legacy `templateId` string from data persisted
 * before multi-select existed, which must not linger alongside the fresh
 * `templateIds` array.
 *
 * If this clip has no zoomEffect at its own time range at all (its own
 * entry was deleted some other way -- e.g. it's what applySelectClipRect
 * used to do to every sequence clip's Ken Burns motion before that bug was
 * fixed), the .map() below that would normally replace it in place has
 * nothing to match and silently drops the freshly-built effect on the
 * floor -- "editing and saving again" LOOKED like it worked (the entry's
 * own templateIds/cropRect genuinely did update) but no animation ever
 * came back. Appending it when nothing matched covers that recovery path,
 * not just the normal in-place edit. */
export function applyEditImageSequenceClip(
  selections: EditSelectionsSnapshot,
  entryId: string,
  assetId: string,
  durationSeconds: number,
  templateIds: string[],
  cropRect: CropRect,
  clipStartSeconds: number,
  removeBackground?: boolean,
  camera3D?: boolean,
  ambientEffect?: AmbientEffectId | null,
  audioReactive?: boolean
): TransformationResult {
  const entryIndex = selections.sequenceClips.findIndex((entry) => entry.id === entryId);
  const entry = selections.sequenceClips[entryIndex];
  if (!entry || entry.kind !== "image") return { label: "Edited image cutaway", state: selections };

  const clampedDuration = Math.min(
    MAX_IMAGE_CLIP_DURATION_SECONDS,
    Math.max(MIN_IMAGE_CLIP_DURATION_SECONDS, durationSeconds)
  );
  const delta = clampedDuration - entry.durationSeconds;

  const shiftEffectRange = <T extends { startTimeSeconds: number; endTimeSeconds: number }>(item: T): T =>
    item.startTimeSeconds >= clipStartSeconds + entry.durationSeconds
      ? { ...item, startTimeSeconds: item.startTimeSeconds + delta, endTimeSeconds: item.endTimeSeconds + delta }
      : item;

  const nextEntries = [...selections.sequenceClips];
  nextEntries[entryIndex] = {
    id: entry.id,
    kind: "image",
    assetId,
    durationSeconds: clampedDuration,
    templateIds,
    cropRect,
    colorFilterId: entry.colorFilterId,
    // Preserves an already-completed matteAssetId when the toggle is left
    // on unchanged (re-editing crop/duration/templates shouldn't re-run a
    // paid matting job) -- only starts fresh (null, patched in by the
    // caller) when the toggle is newly turned on this save.
    backgroundRemoval: removeBackground ? { enabled: true, matteAssetId: entry.backgroundRemoval?.matteAssetId ?? null } : null,
    camera3D,
    ambientEffect,
    audioReactive,
  };

  const newZoomEffect = buildKenBurnsEffect(templateIds, cropRect, clipStartSeconds, clampedDuration);

  const hasExistingEffectAtThisClip = selections.zoomEffects.some(
    (effect) =>
      effect.startTimeSeconds === clipStartSeconds && effect.endTimeSeconds === clipStartSeconds + entry.durationSeconds
  );
  const mappedZoomEffects = selections.zoomEffects.map((effect) =>
    effect.startTimeSeconds === clipStartSeconds && effect.endTimeSeconds === clipStartSeconds + entry.durationSeconds
      ? newZoomEffect
      : shiftEffectRange(effect)
  );
  const nextZoomEffects = hasExistingEffectAtThisClip ? mappedZoomEffects : [...mappedZoomEffects, newZoomEffect];

  return {
    label: "Edited image cutaway",
    state: {
      ...selections,
      sequenceClips: nextEntries,
      zoomEffects: nextZoomEffects,
      overlayImages: selections.overlayImages.map(shiftEffectRange),
      textOverlays: selections.textOverlays.map(shiftEffectRange),
      trimRanges: selections.trimRanges.map(shiftEffectRange),
      videoOverlays: selections.videoOverlays.map(shiftEffectRange),
      ttsOverlays: selections.ttsOverlays.map((overlay) =>
        overlay.startTimeSeconds >= clipStartSeconds + entry.durationSeconds
          ? { ...overlay, startTimeSeconds: overlay.startTimeSeconds + delta }
          : overlay
      ),
      flipHorizontalToggles: selections.flipHorizontalToggles.map((t) => (t >= clipStartSeconds + entry.durationSeconds ? t + delta : t)),
      flipVerticalToggles: selections.flipVerticalToggles.map((t) => (t >= clipStartSeconds + entry.durationSeconds ? t + delta : t)),
    },
  };
}

/** Removes any base-sequence clip entirely -- video or image -- from
 * CutawayTrack's own right-click menu (every clip in the sequence gets a
 * segment there now, not just image cutaways -- see that file's own
 * comment), or CutawayDialog's "Remove Cutaway" (image only, edit mode).
 * `durationSeconds` is passed by the caller rather than read off the entry,
 * since a video entry never stores its own duration (only ever probed from
 * the file, unlike an image entry's authored `durationSeconds`) -- see
 * applyResizeImageClip's own doc comment for why the caller is better
 * positioned to know it. Reuses the same reflow-by-delta logic every other
 * sequence-editing transformation here does: everything timed from this
 * clip's end onward shifts back by its duration, closing the gap. */
export function applyDeleteSequenceClip(
  selections: EditSelectionsSnapshot,
  entryId: string,
  durationSeconds: number,
  clipStartSeconds: number
): TransformationResult {
  const entryIndex = selections.sequenceClips.findIndex((entry) => entry.id === entryId);
  if (entryIndex === -1) return { label: "Removed cutaway", state: selections };

  const clipEndSeconds = clipStartSeconds + durationSeconds;
  const delta = -durationSeconds;

  const shiftEffectRange = <T extends { startTimeSeconds: number; endTimeSeconds: number }>(item: T): T =>
    item.startTimeSeconds >= clipEndSeconds
      ? { ...item, startTimeSeconds: item.startTimeSeconds + delta, endTimeSeconds: item.endTimeSeconds + delta }
      : item;

  const nextEntries = selections.sequenceClips.filter((_, index) => index !== entryIndex);
  const nextZoomEffects = selections.zoomEffects
    .filter((effect) => !(effect.startTimeSeconds === clipStartSeconds && effect.endTimeSeconds === clipEndSeconds))
    .map(shiftEffectRange);

  return {
    label: "Removed cutaway",
    state: {
      ...selections,
      sequenceClips: nextEntries,
      zoomEffects: nextZoomEffects,
      overlayImages: selections.overlayImages.map(shiftEffectRange),
      textOverlays: selections.textOverlays.map(shiftEffectRange),
      trimRanges: selections.trimRanges.map(shiftEffectRange),
      videoOverlays: selections.videoOverlays.map(shiftEffectRange),
      ttsOverlays: selections.ttsOverlays.map((overlay) =>
        overlay.startTimeSeconds >= clipEndSeconds ? { ...overlay, startTimeSeconds: overlay.startTimeSeconds + delta } : overlay
      ),
      flipHorizontalToggles: selections.flipHorizontalToggles.map((t) => (t >= clipEndSeconds ? t + delta : t)),
      flipVerticalToggles: selections.flipVerticalToggles.map((t) => (t >= clipEndSeconds ? t + delta : t)),
    },
  };
}

/** Swaps a base-sequence clip with its immediate neighbor -- MobileAssetStrip's
 * simple up/down reorder buttons (no drag, deliberately -- see the mobile
 * quick-create plan). `entryStartSeconds`/`entryDurationSeconds` are passed
 * by the caller rather than read off the entries themselves, same reasoning
 * as applyDeleteSequenceClip's own `durationSeconds` param: a video entry
 * never stores its own duration, only ever probed from the file.
 *
 * Reflows every time-anchored selection across the swapped pair's combined
 * range, so a reel already carrying desktop-authored zoom/pan effects,
 * overlays, captions, or trims doesn't silently break when reordered on
 * mobile -- same reflow-by-delta idiom as applyDeleteSequenceClip, just with
 * two deltas (one per swapped clip's own former time range) instead of one.
 * Zoom/pan effects get their own shifter (shiftZoomEffectRange) rather than
 * the generic one below, since ZoomEffect has a third time field
 * (epicenterTimeSeconds) that a plain start/end shift would leave stale.
 * No-ops (returns the unchanged state) if there's no such neighbor. */
export function applyReorderSequenceClip(
  selections: EditSelectionsSnapshot,
  entryId: string,
  direction: "earlier" | "later",
  entryStartSeconds: (id: string) => number,
  entryDurationSeconds: (entry: SequenceEntry) => number
): TransformationResult {
  const entries = selections.sequenceClips;
  const index = entries.findIndex((entry) => entry.id === entryId);
  const neighborIndex = direction === "earlier" ? index - 1 : index + 1;
  const label = "Reordered clips";
  if (index === -1 || neighborIndex < 0 || neighborIndex >= entries.length) {
    return { label, state: selections };
  }

  const firstIndex = Math.min(index, neighborIndex);
  const first = entries[firstIndex];
  const second = entries[firstIndex + 1];
  const firstStartSeconds = entryStartSeconds(first.id);
  const firstDurationSeconds = entryDurationSeconds(first);
  const secondDurationSeconds = entryDurationSeconds(second);
  const firstEndSeconds = firstStartSeconds + firstDurationSeconds;
  const secondEndSeconds = firstEndSeconds + secondDurationSeconds;

  // `first`'s old range shifts LATER by `second`'s duration (it now plays
  // right after where `second` used to be); `second`'s old range shifts
  // EARLIER by `first`'s duration (it now plays where `first` used to
  // start). Anything outside [firstStartSeconds, secondEndSeconds) is
  // unaffected -- it belongs to a clip this swap didn't touch.
  function deltaFor(timeSeconds: number): number {
    if (timeSeconds >= firstStartSeconds && timeSeconds < firstEndSeconds) return secondDurationSeconds;
    if (timeSeconds >= firstEndSeconds && timeSeconds < secondEndSeconds) return -firstDurationSeconds;
    return 0;
  }

  const shiftRange = <T extends { startTimeSeconds: number; endTimeSeconds: number }>(item: T): T => {
    const delta = deltaFor(item.startTimeSeconds);
    return delta === 0 ? item : { ...item, startTimeSeconds: item.startTimeSeconds + delta, endTimeSeconds: item.endTimeSeconds + delta };
  };
  const shiftZoomEffectRange = (effect: ZoomEffect): ZoomEffect => {
    const delta = deltaFor(effect.startTimeSeconds);
    return delta === 0
      ? effect
      : {
          ...effect,
          startTimeSeconds: effect.startTimeSeconds + delta,
          epicenterTimeSeconds: effect.epicenterTimeSeconds + delta,
          endTimeSeconds: effect.endTimeSeconds + delta,
        };
  };
  const shiftToggle = (timeSeconds: number): number => timeSeconds + deltaFor(timeSeconds);

  const nextEntries = [...entries];
  nextEntries[firstIndex] = second;
  nextEntries[firstIndex + 1] = first;

  return {
    label,
    state: {
      ...selections,
      sequenceClips: nextEntries,
      zoomEffects: selections.zoomEffects.map(shiftZoomEffectRange),
      overlayImages: selections.overlayImages.map(shiftRange),
      textOverlays: selections.textOverlays.map(shiftRange),
      ttsOverlays: selections.ttsOverlays.map((overlay) => ({
        ...overlay,
        startTimeSeconds: shiftToggle(overlay.startTimeSeconds),
      })),
      videoOverlays: selections.videoOverlays.map(shiftRange),
      trimRanges: selections.trimRanges.map(shiftRange),
      flipHorizontalToggles: selections.flipHorizontalToggles.map(shiftToggle),
      flipVerticalToggles: selections.flipVerticalToggles.map(shiftToggle),
    },
  };
}

/** Moves a base-sequence clip to an arbitrary new position -- CutawayTrack's
 * click-hold-drag reorder, as opposed to applyReorderSequenceClip's
 * adjacent-neighbor-only swap (which backs mobile's up/down buttons and
 * can't express "drop three slots over" in one step). `toIndex` follows
 * Array.splice "move" semantics: the index the clip ends up at in the array
 * AFTER it's already been removed from its old position.
 *
 * Every clip keeps its own duration -- only array order changes -- so the
 * new start time of each clip can be recomputed from scratch by walking the
 * reordered array once. Reflows every time-anchored selection by however
 * much ITS containing clip's start time moved, same reflow-by-delta idiom as
 * applyReorderSequenceClip/applyDeleteSequenceClip, generalized from a fixed
 * swap-pair/single-clip range to however many clips the drag crossed. */
export function applyMoveSequenceClip(
  selections: EditSelectionsSnapshot,
  entryId: string,
  toIndex: number,
  entryStartSeconds: (id: string) => number,
  entryDurationSeconds: (entry: SequenceEntry) => number
): TransformationResult {
  const entries = selections.sequenceClips;
  const fromIndex = entries.findIndex((entry) => entry.id === entryId);
  const label = "Reordered clips";
  const clampedToIndex = Math.max(0, Math.min(toIndex, entries.length - 1));
  if (fromIndex === -1 || clampedToIndex === fromIndex) {
    return { label, state: selections };
  }

  const oldRanges = entries.map((entry) => {
    const startTimeSeconds = entryStartSeconds(entry.id);
    return { id: entry.id, startTimeSeconds, endTimeSeconds: startTimeSeconds + entryDurationSeconds(entry) };
  });

  const nextEntries = [...entries];
  const [moved] = nextEntries.splice(fromIndex, 1);
  nextEntries.splice(clampedToIndex, 0, moved);

  let cursor = 0;
  const deltaByEntryId = new Map<string, number>();
  for (const entry of nextEntries) {
    const oldRange = oldRanges.find((range) => range.id === entry.id)!;
    deltaByEntryId.set(entry.id, cursor - oldRange.startTimeSeconds);
    cursor += oldRange.endTimeSeconds - oldRange.startTimeSeconds;
  }

  function deltaFor(timeSeconds: number): number {
    const range = oldRanges.find((r) => timeSeconds >= r.startTimeSeconds && timeSeconds < r.endTimeSeconds);
    return range ? deltaByEntryId.get(range.id)! : 0;
  }

  const shiftRange = <T extends { startTimeSeconds: number; endTimeSeconds: number }>(item: T): T => {
    const delta = deltaFor(item.startTimeSeconds);
    return delta === 0 ? item : { ...item, startTimeSeconds: item.startTimeSeconds + delta, endTimeSeconds: item.endTimeSeconds + delta };
  };
  const shiftZoomEffectRange = (effect: ZoomEffect): ZoomEffect => {
    const delta = deltaFor(effect.startTimeSeconds);
    return delta === 0
      ? effect
      : {
          ...effect,
          startTimeSeconds: effect.startTimeSeconds + delta,
          epicenterTimeSeconds: effect.epicenterTimeSeconds + delta,
          endTimeSeconds: effect.endTimeSeconds + delta,
        };
  };
  const shiftToggle = (timeSeconds: number): number => timeSeconds + deltaFor(timeSeconds);

  return {
    label,
    state: {
      ...selections,
      sequenceClips: nextEntries,
      zoomEffects: selections.zoomEffects.map(shiftZoomEffectRange),
      overlayImages: selections.overlayImages.map(shiftRange),
      textOverlays: selections.textOverlays.map(shiftRange),
      ttsOverlays: selections.ttsOverlays.map((overlay) => ({
        ...overlay,
        startTimeSeconds: shiftToggle(overlay.startTimeSeconds),
      })),
      videoOverlays: selections.videoOverlays.map(shiftRange),
      trimRanges: selections.trimRanges.map(shiftRange),
      flipHorizontalToggles: selections.flipHorizontalToggles.map(shiftToggle),
      flipVerticalToggles: selections.flipVerticalToggles.map(shiftToggle),
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

/** Adds a new TTS narration overlay -- from TtsOverlayDialog's "Add". Unlike
 * applyAddTextOverlay, the whole overlay (including its own generated
 * assetId/durationSeconds/wordTimings and its authored startTimeSeconds) is
 * assembled by the dialog itself before this is ever called, since building
 * it needs the synthesis result and the current playhead position the
 * dialog already has in scope -- this just appends it. */
export function applyAddTtsOverlay(selections: EditSelectionsSnapshot, overlay: TtsOverlay): TransformationResult {
  return { label: "Added narration", state: { ...selections, ttsOverlays: [...selections.ttsOverlays, overlay] } };
}

/** Replaces an existing TTS narration overlay wholesale -- from
 * TtsOverlayDialog's "Save", reopened for an already-added overlay. Same
 * "the dialog assembles the whole object" reasoning as applyAddTtsOverlay. */
export function applyEditTtsOverlay(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  overlay: TtsOverlay
): TransformationResult {
  if (!selections.ttsOverlays[overlayIndex]) return { label: "Edited narration", state: selections };
  const nextOverlays = [...selections.ttsOverlays];
  nextOverlays[overlayIndex] = overlay;
  return { label: "Edited narration", state: { ...selections, ttsOverlays: nextOverlays } };
}

/** Moving/resizing a TTS overlay's caption rect via its own drag handles --
 * mirrors applyTextOverlayRectCommit. */
export function applyTtsOverlayRectCommit(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  nextRect: CropRect
): TransformationResult {
  const overlay = selections.ttsOverlays[overlayIndex];
  if (!overlay) return { label: "Moved narration", state: selections };
  const nextOverlays = [...selections.ttsOverlays];
  nextOverlays[overlayIndex] = { ...overlay, rect: nextRect };
  return { label: "Moved narration", state: { ...selections, ttsOverlays: nextOverlays } };
}

/** Dragging a TTS overlay to reposition it in time -- unlike
 * applyTextOverlayRangeChange, only startTimeSeconds ever moves: duration
 * comes from the real generated audio (video_math.ts's
 * ttsOverlayEndTimeSeconds), not a freely stretchable end edge. */
export function applyTtsOverlayPositionChange(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  startTimeSeconds: number
): TransformationResult {
  const overlay = selections.ttsOverlays[overlayIndex];
  if (!overlay) return { label: "Moved narration", state: selections };
  const nextOverlays = [...selections.ttsOverlays];
  nextOverlays[overlayIndex] = { ...overlay, startTimeSeconds };
  return { label: "Moved narration", state: { ...selections, ttsOverlays: nextOverlays } };
}

/** TtsOverlayTrack's own per-segment volume badge -- mirrors
 * applyChangeOverlayAudioBalance's clamp-to-0..1 shape. */
export function applyTtsOverlayVolumeChange(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  volume: number
): TransformationResult {
  const overlay = selections.ttsOverlays[overlayIndex];
  if (!overlay) return { label: "Changed narration volume", state: selections };
  const nextOverlays = [...selections.ttsOverlays];
  nextOverlays[overlayIndex] = { ...overlay, volume: Math.min(Math.max(volume, 0), 1) };
  return { label: "Changed narration volume", state: { ...selections, ttsOverlays: nextOverlays } };
}

/** Removes one TTS narration overlay outright. */
export function applyDeleteTtsOverlay(selections: EditSelectionsSnapshot, overlayIndex: number): TransformationResult {
  if (!selections.ttsOverlays[overlayIndex]) return { label: "Removed narration", state: selections };
  return {
    label: "Removed narration",
    state: { ...selections, ttsOverlays: selections.ttsOverlays.filter((_, index) => index !== overlayIndex) },
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
  clips: { layout: VideoOverlayLayout; startTimeSeconds: number; endTimeSeconds: number }[],
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
  videoDurationSeconds: number,
  removeBackground?: boolean,
  // Set (instead of `removeBackground`) for a solid-color screen -- see
  // video_math.ts's BackgroundRemovalState.mode doc comment. Mutually
  // exclusive with `removeBackground` in practice (the picker UI only ever
  // sends one), but if both were somehow set, chroma key wins since it's
  // checked first below.
  chromaKeyColor?: string
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
    // matteAssetId starts null either way. For AI mode, the caller
    // (ThreePaneEditor's handleAddVideoOverlay) kicks off the actual matting
    // job right after this and patches it in later via
    // applySetVideoOverlayBackgroundRemoval once the async job completes,
    // same staging as applyAddSequenceClip's own removeBackground handling
    // above. For chroma key, NO job is EVER requested, here or at render
    // time -- matteAssetId stays permanently null, since both the live
    // preview and Edge Render's actual output key this out entirely
    // client-side (lib/video/chromaKey.ts) -- see video_math.ts's
    // BackgroundRemovalState.mode doc comment.
    ...(chromaKeyColor
      ? { backgroundRemoval: { enabled: true, matteAssetId: null, mode: "chromaKey" as const, chromaKeyColor } }
      : removeBackground
        ? { backgroundRemoval: { enabled: true, matteAssetId: null, mode: "ai" as const } }
        : {}),
  };
  return { label: "Added overlay", state: { ...selections, videoOverlays: [...overlays, newOverlay] } };
}

/** Patches one placed video overlay's backgroundRemoval field in place --
 * the video-overlay equivalent of applySetBackgroundRemoval above, indexed
 * by position in `videoOverlays` (overlays carry no stable id, same
 * convention as applyChangeVideoOverlayLayout/applyToggleSplitScreenSides
 * etc.) rather than by entry id. Used by ThreePaneEditor's request/poll flow
 * to silently write in the real matteAssetId once VEED's job completes --
 * no new undo step for that (same reasoning as applySetBackgroundRemoval's
 * own callers). */
export function applySetVideoOverlayBackgroundRemoval(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  backgroundRemoval: BackgroundRemovalState | null
): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  const label = backgroundRemoval?.enabled ? "Remove background" : "Restore background";
  if (!overlay) return { label, state: selections };
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = { ...overlay, backgroundRemoval };
  return { label, state: { ...selections, videoOverlays: nextOverlays } };
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
 * VideoOverlayTrack's own per-segment volume badge so the mix can be tuned
 * from inside the same popup. All of it is saved together as one undo step
 * rather than several. */
export function applyChangeOverlayFraming(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  framing: OverlayFraming,
  options?: {
    baseFraming?: OverlayFraming;
    ratio?: number;
    audioBalance?: number;
    rect?: CropRect;
    camera3D?: boolean;
    ambientEffect?: AmbientEffectId | null;
    audioReactive?: boolean;
  }
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
    camera3D: options?.camera3D ?? overlay.camera3D,
    ambientEffect: options?.ambientEffect ?? overlay.ambientEffect,
    audioReactive: options?.audioReactive ?? overlay.audioReactive,
  };
  return { label: "Adjusted overlay framing", state: { ...selections, videoOverlays: nextOverlays } };
}

/** Dragging VideoOverlayTrack's own per-segment volume slider -- 0 (default)
 * plays only the base clip's own audio through this window, 1 only the
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

/** OverlaySourceStartDialog's "Save" -- sets which offset into the source
 * footage this overlay starts playing from. Also shrinks endTimeSeconds if
 * the new start point no longer leaves room for the overlay's current
 * on-timeline duration, using the same MIN_VIDEO_OVERLAY_DURATION_SECONDS
 * floor VideoOverlayTrack.tsx's own end-edge drag clamp relies on for a
 * later drag to still find a valid range. `sourceDurationSeconds` is
 * Infinity when not yet probed, in which case this only clamps
 * sourceStartSeconds to >= 0 and leaves endTimeSeconds untouched. */
export function applyChangeVideoOverlaySourceStart(
  selections: EditSelectionsSnapshot,
  overlayIndex: number,
  sourceStartSeconds: number,
  sourceDurationSeconds: number
): TransformationResult {
  const overlay = selections.videoOverlays[overlayIndex];
  if (!overlay) return { label: "Set overlay start point", state: selections };
  const hasKnownSourceDuration = Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0;
  const clampedSourceStart = hasKnownSourceDuration
    ? Math.min(Math.max(sourceStartSeconds, 0), Math.max(sourceDurationSeconds - MIN_VIDEO_OVERLAY_DURATION_SECONDS, 0))
    : Math.max(sourceStartSeconds, 0);
  const remainingSourceSeconds = hasKnownSourceDuration ? sourceDurationSeconds - clampedSourceStart : Infinity;
  const currentDurationSeconds = overlay.endTimeSeconds - overlay.startTimeSeconds;
  const nextDurationSeconds = Number.isFinite(remainingSourceSeconds)
    ? Math.min(currentDurationSeconds, Math.max(remainingSourceSeconds, MIN_VIDEO_OVERLAY_DURATION_SECONDS))
    : currentDurationSeconds;
  const nextOverlays = [...selections.videoOverlays];
  nextOverlays[overlayIndex] = {
    ...overlay,
    sourceStartSeconds: clampedSourceStart,
    endTimeSeconds: overlay.startTimeSeconds + nextDurationSeconds,
  };
  return { label: "Set overlay start point", state: { ...selections, videoOverlays: nextOverlays } };
}

export function applyDeleteVideoOverlay(selections: EditSelectionsSnapshot, overlayIndex: number): TransformationResult {
  if (!selections.videoOverlays[overlayIndex]) return { label: "Removed overlay", state: selections };
  return {
    label: "Removed overlay",
    state: { ...selections, videoOverlays: selections.videoOverlays.filter((_, index) => index !== overlayIndex) },
  };
}
