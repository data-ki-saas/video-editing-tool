"use client";

/**
 * Renders the video sequence "unfolded" into one thumbnail per second, and
 * doubles as a scrub timeline: click anywhere on the strip to seek
 * CanvasPlayer to that time, and a vertical playhead tracks playback
 * position as it advances (see ThreePaneEditor's currentTimeSeconds/onSeek
 * wiring, and CanvasPlayer's seekTo/onTimeUpdate).
 *
 * Each tile is `pixelsPerSecond * (time until the NEXT tile's timestamp)`
 * wide (see `tileWidthsPx` below), not a flat `pixelsPerSecond` -- so this
 * strip's total width telescopes to exactly `durationSeconds *
 * pixelsPerSecond`, the same scale Playground.tsx uses for
 * MainAudioTrackStrip and BackgroundTrackStrip, so all three line up
 * (including the red playhead) and can share one scroll position (see
 * lib/useSyncedHorizontalScroll.ts). A flat per-tile width would instead sum
 * to `thumbnails.length * pixelsPerSecond`, which overshoots `durationSeconds
 * * pixelsPerSecond` by one extra fractional-sample tile per clip (see the
 * next paragraph) -- harmless for the thumbnails themselves, but it drifted
 * every %-based overlay (the playhead, MarkerTrack, ZoomEffectsTrack, ...)
 * away from the audio rails' exact-pixel ticks, worse the more clips there
 * were. Its HEIGHT comes from
 * `frameAspectRatio` (width / height), not from the row's own available
 * height: sizing the box itself to the video's real shape means the image
 * fills it exactly, with no letterboxing, which in turn means
 * CropRectOverlay's percentage positioning (relative to this same box)
 * lines up with the image with no separate correction needed.
 *
 * IMPORTANT: each tile's own timestamp comes from `thumbnailTimestampsSeconds`
 * (built by ThreePaneEditor in lockstep with `thumbnails`), NOT derived
 * from `(index / (thumbnails.length - 1)) * durationSeconds`. That
 * derivation only holds when thumbnails are evenly spaced across the
 * WHOLE duration, which was true for a single clip but breaks once the
 * sequence concatenates several clips' independently-generated thumbnail
 * arrays (each contributing its own extra fractional final-sample
 * thumbnail) -- an even-spacing assumption would drift tile timestamps
 * away from what's actually showing, more so the more clips there are.
 * `clipBoundarySeconds` draws a thin divider at each clip seam so they're
 * visible instead of invisible.
 *
 * Each thumbnail also shows the crop rectangle that would apply at that
 * moment (baseCropRect, or the zoom-interpolated rect from whichever
 * ZoomEffect covers that timestamp -- see lib/video/video_math.ts's
 * computeEffectiveCropRect). Only the ACTIVE tile -- the one whose own
 * timestamp is closest to the current playhead, i.e. the same instant
 * CanvasPlayer is showing -- gets a draggable/resizable overlay (plus
 * flip/mirror edge handles); every other tile stays read-only. This keeps
 * "editing the crop here" meaning exactly one thing regardless of whether
 * you drag on the live preview or on the timeline: both edit the crop at
 * the current time (see ThreePaneEditor's handleCropRectCommit for what
 * that turns into -- either the flat base crop, or one end of a
 * transition that spreads to neighboring frames). Flip/mirror, unlike
 * crop, applies uniformly to the whole clip -- every thumbnail mirrors via
 * a CSS transform, not just the active tile.
 *
 * Each tile's crop rect and flip state only depend on
 * baseCropRect/zoomEffects/flip toggle lists (its own fixed timestamp never
 * changes), NOT on currentTimeSeconds -- FrameTile is memoized so the
 * ~60/sec playhead updates during playback don't re-render every
 * thumbnail, only the active one (as it hands off between tiles) and the
 * separate playhead line element.
 *
 * Rail stacking, top to bottom: MarkerTrack, CutawayTrack (the Cutaways
 * rail -- one segment per base-sequence clip, video or image, see that
 * file's own comment), and TrimTrack (the Cut and Trim rail's
 * click-to-cut gray/red line) all render ABOVE the thumbnails -- they
 * annotate/edit the BASE track itself, not a composited layer, so they sit
 * outside the z-order stack entirely. Directly above the thumbnails sits
 * the actual compositing z-order stack, TOP = FRONTMOST in the rendered
 * video (matches CanvasPlayer.tsx/exportTimeline.ts's own draw order
 * exactly -- see those files' own comments): TtsOverlayTrack (narration
 * captions draw last of all, on top of everything -- see CanvasPlayer.tsx's
 * own draw order), then TextOverlayTrack, then ImageOverlayTrack's
 * Picture-in-Picture row(s), then VideoOverlayTrack's
 * Picture-in-Picture row(s), then ImageOverlayTrack's exclusive
 * (Full-Screen/Split-Screen) row, then VideoOverlayTrack's exclusive row,
 * then the thumbnails themselves (the base plate). ZoomEffectsTrack (every
 * transition's own indicator) and FlipTrack (one per flip axis, when either
 * has any toggles) render BELOW the thumbnails -- they're attribute
 * indicators of the base clip, not stacked layers, so they don't
 * participate in the z-order convention either.
 * All of them live in the SAME
 * scrollable track as the thumbnails, so everything shares one scroll
 * position and one pixel-accurate timeline width with no manual
 * measurement needed.
 * Tiles inside a trimmed range are dimmed (see FrameTile's isTrimmed) --
 * the cut is real (CanvasPlayer's skipTrimmedRanges actually skips it
 * during playback), this is just showing where.
 *
 * Each tile also shows every Picture-in-Picture image/video overlay active
 * at its own instant, and the active Full-Screen/Split-Screen overlay (if
 * any) swaps the tile's own content, exactly matching CanvasPlayer's own
 * draw order -- an overlay sits over the clip, not instead of it. Only the
 * active tile's overlays are draggable/resizable, same gating as the crop
 * rectangle.
 */
import { memo, useMemo, useRef, useState } from "react";
import { CropRectOverlay } from "./CropRectOverlay";
import { OverlayRectOverlay } from "./OverlayRectOverlay";
import { TextOverlayCanvas } from "./TextOverlayCanvas";
import { ZoomEffectsTrack } from "./ZoomEffectsTrack";
import { FlipTrack } from "./FlipTrack";
import { TrimTrack } from "./TrimTrack";
import { TextOverlayTrack } from "./TextOverlayTrack";
import { TtsOverlayTrack } from "./TtsOverlayTrack";
import { VideoOverlayTrack } from "./VideoOverlayTrack";
import { ImageOverlayTrack } from "./ImageOverlayTrack";
import { MarkerTrack } from "./MarkerTrack";
import { CutawayTrack, type CutawaySegment } from "./CutawayTrack";
import { CutTransitionIcon } from "./CutTransitionDialog";
import { normalizeImageTemplateIds } from "@/lib/video/imageTemplates";
import { getFilterPresetOption, type FilterPresetId } from "@/lib/video/filterPresets";
import type { TimelineMarker } from "@/lib/projects";
import {
  computeEffectiveCropRect,
  computeEffectiveFlip,
  computeFlipSegments,
  computeProgress,
  computeOverlayRects,
  isExclusiveLayout,
  findClosestTimestampIndex,
  findTrimRangeIndexAt,
  videoOverlayStartThumbnailKey,
  type CropRect,
  type ImageOverlayClip,
  type SequenceEntry,
  type TextOverlay,
  type TrimRange,
  type TtsOverlay,
  type VideoOverlayClip,
  type VideoOverlayLayout,
  type ZoomEffect,
} from "@/lib/video/video_math";

// One video-overlay source asset's own thumbnails, extracted at the same
// THUMBNAIL_INTERVAL_SECONDS cadence as the base track's own `thumbnails`
// (see ThreePaneEditor.tsx's loadVideoOverlayThumbnailFrames) -- keyed by
// assetId, shared across every placement reusing that asset, same
// convention as videoThumbnailUrlByAssetId/videoOverlayStartThumbnailByKey.
export interface VideoOverlayThumbnailFrames {
  frames: string[];
  timestampsSeconds: number[];
  durationSeconds: number;
}

/** Which of an overlay's own extracted thumbnails (see
 * VideoOverlayThumbnailFrames above) is showing at the BASE timeline's
 * `timestampSeconds` -- converts to the overlay's own LOCAL time
 * (sourceStartSeconds + elapsed-since-this-placement-started, looped once
 * past one play-through, same formula CanvasPlayer's own drawFrameAt uses
 * for the live preview) and picks the closest sampled frame to that local
 * instant, so scrubbing across this overlay's span on the rail actually
 * shows what part of ITS footage would be playing there instead of one
 * static frame reused for the overlay's entire span. Falls back to the
 * seeded-start-frame-then-generic-per-asset-frame chain (same as before
 * this per-tile resolution existed) while framesByAssetId doesn't have this
 * asset yet (still extracting, or failed and never will). */
function resolveVideoOverlayFrameUrl(
  overlay: VideoOverlayClip,
  timestampSeconds: number,
  framesByAssetId: Record<string, VideoOverlayThumbnailFrames>,
  startThumbnailByKey: Record<string, string>,
  genericThumbnailByAssetId: Record<string, string>
): string {
  const frames = framesByAssetId[overlay.assetId];
  if (frames && frames.frames.length > 0) {
    const localOffsetSeconds = overlay.sourceStartSeconds + (timestampSeconds - overlay.startTimeSeconds);
    const loopedOffsetSeconds = frames.durationSeconds > 0 ? localOffsetSeconds % frames.durationSeconds : localOffsetSeconds;
    const frameIndex = findClosestTimestampIndex(frames.timestampsSeconds, loopedOffsetSeconds);
    if (frameIndex !== -1) return frames.frames[frameIndex];
  }
  return (
    startThumbnailByKey[videoOverlayStartThumbnailKey(overlay.assetId, overlay.sourceStartSeconds)] ??
    genericThumbnailByAssetId[overlay.assetId] ??
    ""
  );
}

const FrameTile = memo(function FrameTile({
  src,
  index,
  widthPx,
  frameAspectRatio,
  cropRect,
  flipHorizontal,
  flipVertical,
  isTrimmed,
  assetUrlById,
  textOverlays,
  imageOverlayPips,
  videoOverlayPips,
  activeExclusiveImageOverlay,
  activeExclusiveVideoOverlay,
  activeExclusiveVideoOverlayFrameUrl,
  isImageClip,
  colorFilterId,
  onChange,
  onCommit,
  onFlipHorizontal,
  onFlipVertical,
  onTextOverlayRectChange,
  onTextOverlayRectCommit,
  onImageOverlayRectChange,
  onImageOverlayRectCommit,
  onVideoOverlayRectChange,
  onVideoOverlayRectCommit,
}: {
  src: string;
  index: number;
  widthPx: number;
  frameAspectRatio: number | null;
  cropRect: CropRect | null;
  flipHorizontal: boolean;
  flipVertical: boolean;
  isTrimmed: boolean;
  assetUrlById: Record<string, string>;
  textOverlays: { overlay: TextOverlay; overlayIndex: number; progress: number }[];
  // Picture-in-Picture image overlays active at this tile's instant --
  // rendered with the same OverlayRectOverlay component video overlays
  // use, styled fuchsia (this file's own image-overlay PiP color, see
  // ImageOverlayTrack.tsx) so the two overlay kinds read as visually
  // distinct when both are present.
  imageOverlayPips: { overlay: ImageOverlayClip; overlayIndex: number }[];
  // Picture-in-Picture video overlays active at this tile's instant --
  // rendered with the same OverlayRectOverlay component image overlays
  // already use (move/resize drag), just styled violet instead of fuchsia
  // so the two overlay kinds read as visually distinct when both are
  // present. `frameUrl` is this tile's own instant resolved against the
  // overlay's OWN footage (see FrameStrip's resolveVideoOverlayFrameUrl) --
  // NOT a single static thumbnail reused across every tile the overlay
  // spans, so scrubbing across its span actually shows what part of its
  // footage would be playing at each point, same as the base track already
  // does for its own per-second thumbnails.
  videoOverlayPips: { overlay: VideoOverlayClip; overlayIndex: number; frameUrl: string }[];
  // The Full-Screen or Split-Screen IMAGE overlay active at this tile's
  // instant, if any -- takes priority over activeExclusiveVideoOverlay
  // below when both are present (matches CanvasPlayer's own draw order:
  // an active image-exclusive overlay is painted AFTER the video-exclusive
  // layer, so it wins on overlap -- see that file's own comment).
  activeExclusiveImageOverlay: ImageOverlayClip | null;
  // The Full-Screen or Split-Screen VIDEO overlay active at this tile's
  // instant, if any (at most one per array, since those two layouts are
  // mutually exclusive with each other -- see video_math.ts's
  // isExclusiveLayout) -- swaps in that overlay's own thumbnail
  // (Full-Screen) or splits the tile into the two halves CanvasPlayer's own
  // drawFrameAt already renders (Split Screen), so the timeline strip shows
  // the same thing the live preview does instead of silently continuing to
  // show the base clip's own frame. Only used when no image-exclusive
  // overlay is active at the same instant.
  activeExclusiveVideoOverlay: VideoOverlayClip | null;
  // This tile's own instant resolved against activeExclusiveVideoOverlay's
  // OWN footage -- same per-tile resolution as videoOverlayPips' own
  // frameUrl above, just for the exclusive-layout case (at most one active
  // overlay, not a list). Null exactly when activeExclusiveVideoOverlay is.
  activeExclusiveVideoOverlayFrameUrl: string | null;
  // True when this tile's timestamp falls inside an image (cutaway) clip
  // rather than a video one -- its `src` is that cutaway's own photo, held
  // unchanged for the whole clip (see ThreePaneEditor's extractSequence),
  // NOT a video frame captured at this tile's own native resolution. A
  // video frame's real aspect ratio always equals `frameAspectRatio` (both
  // come from the same loaded clip), so object-cover never actually crops
  // it -- box and image already agree. A cutaway photo's own aspect ratio
  // is unrelated to frameAspectRatio (it comes from whichever VIDEO loaded
  // first in the sequence), so forcing it into that box with object-cover
  // crops an arbitrary, uncontrolled slice of it. object-contain instead
  // (see the default-fill branch below) always shows the whole photo,
  // undistorted, letterboxed to fit -- this only affects that one fill
  // mode, not the crop-guide/overlay boxes drawn on top (out of scope here).
  isImageClip: boolean;
  // This tile's own base-clip color filter (from the sequence entry it
  // falls under -- see tileColorFilterId below) -- applied via CSS `filter`
  // to every base-clip <img> below, the same cssFilter CanvasPlayer already
  // applies via ctx.filter, so the track's frames match the live preview
  // instead of always showing the unfiltered source image.
  colorFilterId: FilterPresetId | null;
  onChange?: (next: CropRect) => void;
  onCommit?: (next: CropRect) => void;
  onFlipHorizontal?: () => void;
  onFlipVertical?: () => void;
  onTextOverlayRectChange?: (overlayIndex: number, next: CropRect) => void;
  onTextOverlayRectCommit?: (overlayIndex: number, next: CropRect) => void;
  onImageOverlayRectChange?: (overlayIndex: number, next: CropRect) => void;
  onImageOverlayRectCommit?: (overlayIndex: number, next: CropRect) => void;
  onVideoOverlayRectChange?: (overlayIndex: number, next: CropRect) => void;
  onVideoOverlayRectCommit?: (overlayIndex: number, next: CropRect) => void;
}) {
  const scaleX = flipHorizontal ? -1 : 1;
  const scaleY = flipVertical ? -1 : 1;
  const flipStyle = scaleX !== 1 || scaleY !== 1 ? { transform: `scale(${scaleX}, ${scaleY})` } : undefined;

  // Same cssFilter CanvasPlayer applies via ctx.filter -- see
  // filterPresets.ts's module comment for why these must never drift.
  const baseCssFilter = getFilterPresetOption(colorFilterId).cssFilter;
  const baseImgStyle = { ...flipStyle, filter: baseCssFilter };
  const imageOverlayCssFilter = getFilterPresetOption(activeExclusiveImageOverlay?.colorFilterId ?? null).cssFilter;
  const videoOverlayCssFilter = getFilterPresetOption(activeExclusiveVideoOverlay?.colorFilterId ?? null).cssFilter;

  function rectStyle(rect: CropRect): React.CSSProperties {
    return { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` };
  }

  const exclusiveImageOverlayRects =
    activeExclusiveImageOverlay && activeExclusiveImageOverlay.layout.type !== "picture-in-picture"
      ? computeOverlayRects(activeExclusiveImageOverlay.layout)
      : null;
  const exclusiveVideoOverlayRects =
    !exclusiveImageOverlayRects && activeExclusiveVideoOverlay && activeExclusiveVideoOverlay.layout.type !== "picture-in-picture"
      ? computeOverlayRects(activeExclusiveVideoOverlay.layout)
      : null;

  return (
    // overflow-hidden is load-bearing: CropRectOverlay dims outside its rect
    // via a 9999px box-shadow, which is only ever clipped by an ancestor's
    // overflow -- without this, every tile's shadow bleeds across all its
    // neighbors, and with ~100+ tiles stacking that effect the whole strip
    // reads as going dark ("frames disappearing" while scrolling further
    // into it, since more tiles compounding the bleed come into view).
    //
    // Natural height from width + aspect-ratio, not capped to fit some
    // container height -- if that makes the row taller than the
    // Playground's allocated space, Playground.tsx scrolls vertically
    // rather than this shrinking (or centering with padding) to fit.
    <div
      className={`relative shrink-0 overflow-hidden ${isTrimmed ? "opacity-30" : ""}`}
      style={{ width: widthPx, aspectRatio: frameAspectRatio ?? undefined }}
    >
      {/* Safe to fill the box exactly (object-cover would normally risk
          cropping) -- the box's own aspect-ratio already matches the
          image's, so there is nothing to crop. */}
      {activeExclusiveImageOverlay?.layout.type === "full-screen" ? (
        // Full-Screen image overlay wins over any active video-exclusive
        // overlay at the same instant (see this file's own comment) -- the
        // photo itself fills the tile.
        // eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL, not a Next-optimizable static asset
        <img
          src={assetUrlById[activeExclusiveImageOverlay.assetId] ?? ""}
          alt={`Frame at ${index}s`}
          className="h-full w-full object-cover"
          style={{ filter: imageOverlayCssFilter }}
        />
      ) : exclusiveImageOverlayRects && activeExclusiveImageOverlay ? (
        <>
          <div className="absolute overflow-hidden" style={rectStyle(exclusiveImageOverlayRects.baseRect!)}>
            {/* eslint-disable-next-line @next/next/no-img-element -- short-lived data URLs, not a Next-optimizable remote image */}
            <img src={src} alt={`Frame at ${index}s`} className="h-full w-full object-cover" style={baseImgStyle} />
          </div>
          <div className="absolute overflow-hidden" style={rectStyle(exclusiveImageOverlayRects.overlayRect)}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL, not a Next-optimizable static asset */}
            <img
              src={assetUrlById[activeExclusiveImageOverlay.assetId] ?? ""}
              alt=""
              className="h-full w-full object-cover"
              style={{ filter: imageOverlayCssFilter }}
            />
          </div>
        </>
      ) : activeExclusiveVideoOverlay?.layout.type === "full-screen" ? (
        // Full-Screen: the overlay's own thumbnail fills the tile, same as
        // CanvasPlayer fully covering the base frame for this window -- no
        // flip transform, since CanvasPlayer never flips the overlay's own
        // footage, only the base clip's.
        // eslint-disable-next-line @next/next/no-img-element -- reuses AssetGallery's own extracted video-tile thumbnail, not a Next-optimizable static asset
        <img
          src={activeExclusiveVideoOverlayFrameUrl ?? ""}
          alt={`Frame at ${index}s`}
          className="h-full w-full object-cover"
          style={{ filter: videoOverlayCssFilter }}
        />
      ) : exclusiveVideoOverlayRects && activeExclusiveVideoOverlay ? (
        // Split Screen: base clip in its own half (still flipped, still the
        // real per-second thumbnail), overlay's own thumbnail in the other
        // half -- same division CanvasPlayer's drawFrameAt already renders.
        <>
          <div className="absolute overflow-hidden" style={rectStyle(exclusiveVideoOverlayRects.baseRect!)}>
            {/* eslint-disable-next-line @next/next/no-img-element -- short-lived data URLs, not a Next-optimizable remote image */}
            <img src={src} alt={`Frame at ${index}s`} className="h-full w-full object-cover" style={baseImgStyle} />
          </div>
          <div className="absolute overflow-hidden" style={rectStyle(exclusiveVideoOverlayRects.overlayRect)}>
            {/* eslint-disable-next-line @next/next/no-img-element -- reuses AssetGallery's own extracted video-tile thumbnail, not a Next-optimizable static asset */}
            <img
              src={activeExclusiveVideoOverlayFrameUrl ?? ""}
              alt=""
              className="h-full w-full object-cover"
              style={{ filter: videoOverlayCssFilter }}
            />
          </div>
        </>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived data URLs, not a Next-optimizable remote image
        <img
          src={src}
          alt={`Frame at ${index}s`}
          className={`h-full w-full ${isImageClip ? "object-contain" : "object-cover"}`}
          style={baseImgStyle}
        />
      )}
      {cropRect && (
        <CropRectOverlay
          cropRect={cropRect}
          onChange={onChange}
          onCommit={onCommit}
          onFlipHorizontal={onFlipHorizontal}
          onFlipVertical={onFlipVertical}
        />
      )}
      {videoOverlayPips.map(({ overlay, overlayIndex, frameUrl }) => {
        if (overlay.layout.type !== "picture-in-picture") return null;
        return (
          <OverlayRectOverlay
            key={`video-${overlayIndex}`}
            rect={overlay.layout.rect}
            imageUrl={frameUrl}
            cssFilter={getFilterPresetOption(overlay.colorFilterId ?? null).cssFilter}
            framing={overlay.framing}
            borderColorClassName="border-violet-400"
            handleColorClassName="bg-violet-400"
            onChange={onVideoOverlayRectChange ? (next) => onVideoOverlayRectChange(overlayIndex, next) : undefined}
            onCommit={onVideoOverlayRectCommit ? (next) => onVideoOverlayRectCommit(overlayIndex, next) : undefined}
          />
        );
      })}
      {imageOverlayPips.map(({ overlay, overlayIndex }) => {
        if (overlay.layout.type !== "picture-in-picture") return null;
        return (
          <OverlayRectOverlay
            key={`image-${overlayIndex}`}
            rect={overlay.layout.rect}
            imageUrl={assetUrlById[overlay.assetId] ?? ""}
            cssFilter={getFilterPresetOption(overlay.colorFilterId ?? null).cssFilter}
            framing={overlay.framing}
            borderColorClassName="border-fuchsia-400"
            handleColorClassName="bg-fuchsia-400"
            onChange={onImageOverlayRectChange ? (next) => onImageOverlayRectChange(overlayIndex, next) : undefined}
            onCommit={onImageOverlayRectCommit ? (next) => onImageOverlayRectCommit(overlayIndex, next) : undefined}
          />
        );
      })}
      {textOverlays.map(({ overlay, overlayIndex, progress }) => (
        <OverlayRectOverlay
          key={overlayIndex}
          rect={overlay.rect}
          onChange={onTextOverlayRectChange ? (next) => onTextOverlayRectChange(overlayIndex, next) : undefined}
          onCommit={onTextOverlayRectCommit ? (next) => onTextOverlayRectCommit(overlayIndex, next) : undefined}
          renderInner={
            <TextOverlayCanvas text={overlay.text} templateId={overlay.templateId} progress={progress} className="h-full w-full" />
          }
        />
      ))}
    </div>
  );
});

export function FrameStrip({
  thumbnails,
  thumbnailTimestampsSeconds,
  clipBoundarySeconds,
  sequenceEntries,
  onResizeImageClip,
  onEditCutaway,
  onDeleteCutaway,
  onOpenCutawayFilter,
  onOpenCutawayCanvasFill,
  onOpenClipTransition,
  isLoading,
  durationSeconds,
  currentTimeSeconds,
  onSeek,
  baseCropRect,
  zoomEffects,
  frameAspectRatio,
  onChangeZoomRange,
  onCommitZoomRange,
  onChangeZoomEpicenter,
  onCommitZoomEpicenter,
  onDeleteZoomEffect,
  onCropRectChange,
  onCropRectCommit,
  flipHorizontalToggles,
  flipVerticalToggles,
  onFlipHorizontal,
  onFlipVertical,
  onDeleteFlipHorizontalSegment,
  onDeleteFlipVerticalSegment,
  trimRanges,
  pendingTrimStartSeconds,
  onTrimTrackClick,
  onMoveTrimDot,
  onDeleteTrimRange,
  overlayImages,
  assetUrlById,
  onChangeImageOverlayRect,
  onCommitImageOverlayRect,
  onChangeImageOverlayRange,
  onCommitImageOverlayRange,
  onChangeImageOverlayPosition,
  onCommitImageOverlayPosition,
  onChangeImageOverlayLayout,
  onToggleImageSplitScreenOrientation,
  onToggleImageSplitScreenSides,
  onOpenImageOverlayFraming,
  onOpenImageOverlayFilter,
  onDeleteImageOverlay,
  textOverlays,
  onChangeTextOverlayRect,
  onCommitTextOverlayRect,
  onChangeTextOverlayRange,
  onCommitTextOverlayRange,
  onDeleteTextOverlay,
  onRequestEditTextOverlay,
  ttsOverlays,
  onChangeTtsOverlayPosition,
  onCommitTtsOverlayPosition,
  onChangeTtsOverlayVolume,
  onCommitTtsOverlayVolume,
  onEditTtsOverlay,
  onDeleteTtsOverlay,
  videoOverlays,
  videoThumbnailUrlByAssetId,
  videoOverlayStartThumbnailByKey,
  videoOverlayThumbnailFramesByAssetId,
  overlaySourceDurationSeconds,
  onChangeVideoOverlayRect,
  onCommitVideoOverlayRect,
  onChangeVideoOverlayRange,
  onCommitVideoOverlayRange,
  onChangeVideoOverlayPosition,
  onCommitVideoOverlayPosition,
  onChangeVideoOverlayLayout,
  onToggleSplitScreenOrientation,
  onToggleSplitScreenSides,
  onOpenVideoOverlayFraming,
  onOpenVideoOverlayFilter,
  onDeleteVideoOverlay,
  onChangeOverlayAudioBalance,
  onCommitOverlayAudioBalance,
  onOpenSourceStart,
  markers,
  onAddMarker,
  onMoveMarker,
  onRenameMarker,
  onDeleteMarker,
  onTogglePinMarker,
  pixelsPerSecond,
  scrollContainerRef,
  onScroll,
}: {
  thumbnails: string[];
  thumbnailTimestampsSeconds: number[];
  clipBoundarySeconds: number[];
  // In-order clip metadata, aligned with the groupings clipBoundarySeconds
  // divides -- sequenceEntries[i] is the clip that ENDS at
  // clipBoundarySeconds[i]. Only an "image" entry's boundary becomes a
  // drag handle (see handleBoundaryPointerDown below); a video seam stays
  // the plain read-only divider it always was.
  sequenceEntries: SequenceEntry[];
  onResizeImageClip: (entryId: string, newDurationSeconds: number, clipStartSeconds: number) => void;
  // The Cutaways rail's own click -- opens CutawayDialog pre-filled to
  // edit that cutaway in place (image segments only), rather than
  // appending a fresh one.
  onEditCutaway: (segment: CutawaySegment) => void;
  // The Cutaways rail's own right-click "Remove Cutaway" -- splices the
  // clip out of the sequence entirely (see applyDeleteSequenceClip).
  onDeleteCutaway: (segment: CutawaySegment) => void;
  // The Cutaways rail's own right-click "Filter" -- opens FilterPresetDialog
  // scoped to just this cutaway (see applySelectCutawayFilterPreset).
  onOpenCutawayFilter: (segment: CutawaySegment) => void;
  // The Cutaways rail's own right-click "Canvas fill" -- opens
  // CanvasFillDialog scoped to just this cutaway (see
  // applySelectCanvasFillMode).
  onOpenCutawayCanvasFill: (segment: CutawaySegment) => void;
  // The clip-boundary transition badge's own click (see clipBoundarySeconds'
  // own render block below) -- opens CutTransitionDialog scoped to the
  // INCOMING clip of that boundary (whichever sequenceEntries[index+1] is),
  // since that's the entry cutTransitionInId actually lives on (see
  // video_math.ts's SequenceEntry doc comment).
  onOpenClipTransition: (entry: SequenceEntry) => void;
  isLoading: boolean;
  durationSeconds: number;
  currentTimeSeconds: number;
  onSeek: (seconds: number) => void;
  baseCropRect: CropRect | null;
  zoomEffects: ZoomEffect[];
  frameAspectRatio: number | null;
  onChangeZoomRange: (effectIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitZoomRange: (effectIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onChangeZoomEpicenter: (effectIndex: number, epicenterTimeSeconds: number) => void;
  onCommitZoomEpicenter: (effectIndex: number, epicenterTimeSeconds: number) => void;
  onDeleteZoomEffect: (effectIndex: number) => void;
  onCropRectChange: (next: CropRect) => void;
  onCropRectCommit: (next: CropRect) => void;
  flipHorizontalToggles: number[];
  flipVerticalToggles: number[];
  onFlipHorizontal: () => void;
  onFlipVertical: () => void;
  // FlipTrack's own right-click "Delete flip"/"Delete mirror" -- removes the
  // toggle pair (or lone trailing toggle) bounding that segment, see
  // transformations.ts's applyDeleteFlipSegment.
  onDeleteFlipHorizontalSegment: (segmentIndex: number) => void;
  onDeleteFlipVerticalSegment: (segmentIndex: number) => void;
  trimRanges: TrimRange[];
  pendingTrimStartSeconds: number | null;
  onTrimTrackClick: (timeSeconds: number) => void;
  onMoveTrimDot: (timeSeconds: number) => void;
  onDeleteTrimRange: (rangeIndex: number) => void;
  overlayImages: ImageOverlayClip[];
  assetUrlById: Record<string, string>;
  onChangeImageOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onCommitImageOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onChangeImageOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitImageOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onChangeImageOverlayPosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onCommitImageOverlayPosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onChangeImageOverlayLayout: (
    overlayIndex: number,
    layoutType: VideoOverlayLayout["type"],
    splitScreenOrientation?: "horizontal" | "vertical"
  ) => void;
  onToggleImageSplitScreenOrientation: (overlayIndex: number) => void;
  onToggleImageSplitScreenSides: (overlayIndex: number) => void;
  onOpenImageOverlayFraming: (overlayIndex: number) => void;
  // This overlay's own right-click "Filter" -- opens FilterPresetDialog
  // scoped to just this overlay (see applySelectImageOverlayFilterPreset).
  onOpenImageOverlayFilter: (overlayIndex: number) => void;
  onDeleteImageOverlay: (overlayIndex: number) => void;
  textOverlays: TextOverlay[];
  onChangeTextOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onCommitTextOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onChangeTextOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitTextOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onDeleteTextOverlay: (overlayIndex: number) => void;
  onRequestEditTextOverlay: (overlayIndex: number) => void;
  ttsOverlays: TtsOverlay[];
  onChangeTtsOverlayPosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onCommitTtsOverlayPosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onChangeTtsOverlayVolume: (overlayIndex: number, level: number) => void;
  onCommitTtsOverlayVolume: (overlayIndex: number, level: number) => void;
  onEditTtsOverlay: (overlayIndex: number) => void;
  onDeleteTtsOverlay: (overlayIndex: number) => void;
  videoOverlays: VideoOverlayClip[];
  videoThumbnailUrlByAssetId: Record<string, string>;
  // Seeded-start-frame fallback for resolveVideoOverlayFrameUrl above, used
  // only until videoOverlayThumbnailFramesByAssetId has this overlay's own
  // asset (or if extraction fails and never does).
  videoOverlayStartThumbnailByKey: Record<string, string>;
  // Each video-overlay asset's own extracted per-second thumbnails --
  // see VideoOverlayThumbnailFrames/resolveVideoOverlayFrameUrl above and
  // ThreePaneEditor.tsx's own extraction effect.
  videoOverlayThumbnailFramesByAssetId: Record<string, VideoOverlayThumbnailFrames>;
  overlaySourceDurationSeconds: Record<string, number>;
  onChangeVideoOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onCommitVideoOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onChangeVideoOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitVideoOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onChangeVideoOverlayPosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onCommitVideoOverlayPosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onChangeVideoOverlayLayout: (
    overlayIndex: number,
    layoutType: VideoOverlayLayout["type"],
    splitScreenOrientation?: "horizontal" | "vertical"
  ) => void;
  onToggleSplitScreenOrientation: (overlayIndex: number) => void;
  onToggleSplitScreenSides: (overlayIndex: number) => void;
  onOpenVideoOverlayFraming: (overlayIndex: number) => void;
  // Same as onOpenImageOverlayFilter, for a video overlay (see
  // applySelectVideoOverlayFilterPreset).
  onOpenVideoOverlayFilter: (overlayIndex: number) => void;
  onDeleteVideoOverlay: (overlayIndex: number) => void;
  onChangeOverlayAudioBalance: (overlayIndex: number, balance: number) => void;
  onCommitOverlayAudioBalance: (overlayIndex: number, balance: number) => void;
  onOpenSourceStart: (overlayIndex: number) => void;
  markers: TimelineMarker[];
  onAddMarker: (timeSeconds: number) => void;
  onMoveMarker: (index: number, timeSeconds: number) => void;
  onRenameMarker: (index: number, label: string) => void;
  onDeleteMarker: (index: number) => void;
  onTogglePinMarker: (index: number) => void;
  pixelsPerSecond: number;
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  // Post-add duration drag on an image clip's own boundary marker (the
  // popup that adds the clip sets its INITIAL duration; this is how it
  // stays adjustable afterward, on the main timeline, per the driving
  // vision's "direct manipulation over dialogs" bias). Kept entirely LOCAL
  // to this component while dragging -- only the final release fires
  // onResizeImageClip -- rather than lifting a live value up to
  // ThreePaneEditor on every pointermove, since committing there re-runs
  // the whole thumbnail/duration extraction effect (expensive to do at
  // 60fps of drag deltas).
  const [draggingBoundary, setDraggingBoundary] = useState<{
    index: number;
    clipStartSeconds: number;
    candidateSeconds: number;
  } | null>(null);

  function handleBoundaryPointerDown(
    index: number,
    clipStartSeconds: number,
    boundarySeconds: number,
    e: React.PointerEvent<HTMLDivElement>
  ) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingBoundary({ index, clipStartSeconds, candidateSeconds: boundarySeconds });
  }
  function handleBoundaryPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingBoundary || !trackRef.current || durationSeconds <= 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    setDraggingBoundary({ ...draggingBoundary, candidateSeconds: fraction * durationSeconds });
  }
  function handleBoundaryPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (!draggingBoundary) return;
    const entry = sequenceEntries[draggingBoundary.index];
    if (entry?.kind === "image") {
      const newDurationSeconds = draggingBoundary.candidateSeconds - draggingBoundary.clipStartSeconds;
      onResizeImageClip(entry.id, newDurationSeconds, draggingBoundary.clipStartSeconds);
    }
    setDraggingBoundary(null);
  }

  // Recomputed only when the crop/zoom actually changes -- NOT on every
  // currentTimeSeconds tick during playback (see FrameTile's memo comment).
  const tileCropRects = useMemo(() => {
    if (!baseCropRect) return thumbnails.map(() => null);
    return thumbnailTimestampsSeconds.map((timestamp) => computeEffectiveCropRect(baseCropRect, zoomEffects, timestamp));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, baseCropRect, zoomEffects]);

  // Each tile spans from its own timestamp up to the NEXT tile's timestamp
  // (or, for the very last tile, up to durationSeconds) -- see this file's
  // module comment for why a flat pixelsPerSecond-per-tile width drifts the
  // strip's total width away from durationSeconds * pixelsPerSecond. This
  // telescopes: consecutive deltas sum to durationSeconds - timestamps[0]
  // (== durationSeconds, since the first timestamp is always 0), so the
  // track's emergent w-max width lands on exactly the same total the audio
  // rails use. Each clip's own extra fractional final-sample timestamp
  // (see thumbnailTimestampsSeconds's own doc) collapses to a near-zero-width
  // sliver tile here rather than a full extra pixelsPerSecond-wide one.
  const tileWidthsPx = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp, index) => {
      const nextTimestamp =
        index < thumbnailTimestampsSeconds.length - 1 ? thumbnailTimestampsSeconds[index + 1] : durationSeconds;
      return Math.max(0, nextTimestamp - timestamp) * pixelsPerSecond;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, durationSeconds, pixelsPerSecond]);

  const tileFlips = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) => ({
      flipHorizontal: computeEffectiveFlip(flipHorizontalToggles, timestamp),
      flipVertical: computeEffectiveFlip(flipVerticalToggles, timestamp),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, flipHorizontalToggles, flipVerticalToggles]);

  const flipHorizontalSegments = useMemo(
    () => computeFlipSegments(flipHorizontalToggles, durationSeconds),
    [flipHorizontalToggles, durationSeconds]
  );
  const flipVerticalSegments = useMemo(
    () => computeFlipSegments(flipVerticalToggles, durationSeconds),
    [flipVerticalToggles, durationSeconds]
  );

  // Which sequence entry each tile's timestamp falls under, boiled down to
  // just "is it an image clip" -- see FrameTile's own isImageClip prop
  // comment for why that tile needs to know. clipBoundarySeconds[i] is the
  // END of sequenceEntries[i] (see this file's own prop comment), so the
  // first boundary a timestamp is still strictly before it names its clip;
  // past every boundary means the last entry.
  const tileIsImageClip = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) => {
      const entryIndex = clipBoundarySeconds.findIndex((boundary) => timestamp < boundary);
      const resolvedIndex = entryIndex === -1 ? sequenceEntries.length - 1 : entryIndex;
      return sequenceEntries[resolvedIndex]?.kind === "image";
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, clipBoundarySeconds, sequenceEntries]);

  // Same resolution as tileIsImageClip above, but for the resolved clip's
  // own colorFilterId -- lets each tile paint with the same cssFilter
  // CanvasPlayer applies to its own frame at that instant (see FrameTile's
  // colorFilterId prop comment).
  const tileColorFilterId = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) => {
      const entryIndex = clipBoundarySeconds.findIndex((boundary) => timestamp < boundary);
      const resolvedIndex = entryIndex === -1 ? sequenceEntries.length - 1 : entryIndex;
      return sequenceEntries[resolvedIndex]?.colorFilterId ?? null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, clipBoundarySeconds, sequenceEntries]);

  const tileIsTrimmed = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) => findTrimRangeIndexAt(trimRanges, timestamp) !== -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, trimRanges]);

  const tileTextOverlays = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) =>
      textOverlays
        .map((overlay, overlayIndex) => ({
          overlay,
          overlayIndex,
          progress: computeProgress(overlay.startTimeSeconds, overlay.endTimeSeconds, timestamp),
        }))
        .filter(({ overlay }) => timestamp >= overlay.startTimeSeconds && timestamp < overlay.endTimeSeconds)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, textOverlays]);

  // Same shape as tileTextOverlays above, but for the Picture-in-Picture-
  // layout image overlays active at each tile's own instant -- the only
  // layout with a rect to drag on the active tile (Full-Screen/Split-Screen
  // have no on-canvas rect at all, per video_math.ts's VideoOverlayLayout,
  // reused verbatim for ImageOverlayClip).
  const tileImageOverlayPips = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) =>
      overlayImages
        .map((overlay, overlayIndex) => ({ overlay, overlayIndex }))
        .filter(
          ({ overlay }) =>
            overlay.layout.type === "picture-in-picture" && timestamp >= overlay.startTimeSeconds && timestamp < overlay.endTimeSeconds
        )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, overlayImages]);

  // Same shape as tileImageOverlayPips above, but for video overlays --
  // additionally resolving each active overlay's own `frameUrl` at this
  // tile's instant (see resolveVideoOverlayFrameUrl above), so a PiP
  // overlay spanning several tiles shows a different frame of ITS footage
  // per tile instead of one static frame reused across its whole span.
  const tileVideoOverlayPips = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) =>
      videoOverlays
        .map((overlay, overlayIndex) => ({ overlay, overlayIndex }))
        .filter(
          ({ overlay }) =>
            overlay.layout.type === "picture-in-picture" && timestamp >= overlay.startTimeSeconds && timestamp < overlay.endTimeSeconds
        )
        .map(({ overlay, overlayIndex }) => ({
          overlay,
          overlayIndex,
          frameUrl: resolveVideoOverlayFrameUrl(
            overlay,
            timestamp,
            videoOverlayThumbnailFramesByAssetId,
            videoOverlayStartThumbnailByKey,
            videoThumbnailUrlByAssetId
          ),
        }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [
    thumbnails.length,
    thumbnailTimestampsSeconds,
    videoOverlays,
    videoOverlayThumbnailFramesByAssetId,
    videoOverlayStartThumbnailByKey,
    videoThumbnailUrlByAssetId,
  ]);

  // Every meaningful time reference on this strip, combined into one list
  // for VideoOverlayTrack/ImageOverlayTrack's drag-to-snap (see its own
  // comment and video_math.ts's snapToNearest) -- 0/full duration/the
  // playhead, every clip seam, every zoom effect's own edges, every trim
  // range's own edges, and every video/image overlay's own edges (including
  // the one currently being dragged, which is harmless -- see
  // VideoOverlayTrack.tsx's doc comment).
  const overlaySnapPointsSeconds = useMemo(() => {
    const points = [0, durationSeconds, currentTimeSeconds, ...clipBoundarySeconds];
    for (const effect of zoomEffects) {
      points.push(effect.startTimeSeconds, effect.epicenterTimeSeconds, effect.endTimeSeconds);
    }
    for (const range of trimRanges) {
      points.push(range.startTimeSeconds, range.endTimeSeconds);
    }
    for (const overlay of videoOverlays) {
      points.push(overlay.startTimeSeconds, overlay.endTimeSeconds);
    }
    for (const overlay of overlayImages) {
      points.push(overlay.startTimeSeconds, overlay.endTimeSeconds);
    }
    return points;
  }, [durationSeconds, currentTimeSeconds, clipBoundarySeconds, zoomEffects, trimRanges, videoOverlays, overlayImages]);

  // The Full-Screen or Split-Screen overlay (if any) active at each tile's
  // own instant, per clip type -- at most one PER TYPE, since those two
  // layouts are mutually exclusive with each other only WITHIN the same
  // array (isExclusiveLayout). Lets FrameTile swap in that overlay's own
  // thumbnail / split the tile, matching what CanvasPlayer's drawFrameAt
  // already renders for the same instant -- without this, the timeline
  // strip silently kept showing the base clip's own frame with no
  // indication an overlay was active there at all.
  const tileActiveExclusiveImageOverlay = useMemo(() => {
    return thumbnailTimestampsSeconds.map(
      (timestamp) =>
        overlayImages.find(
          (overlay) => isExclusiveLayout(overlay.layout) && timestamp >= overlay.startTimeSeconds && timestamp < overlay.endTimeSeconds
        ) ?? null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, overlayImages]);

  const tileActiveExclusiveVideoOverlay = useMemo(() => {
    return thumbnailTimestampsSeconds.map(
      (timestamp) =>
        videoOverlays.find(
          (overlay) => isExclusiveLayout(overlay.layout) && timestamp >= overlay.startTimeSeconds && timestamp < overlay.endTimeSeconds
        ) ?? null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, videoOverlays]);

  // This tile's own instant resolved against tileActiveExclusiveVideoOverlay
  // (above)'s own footage -- same per-tile resolution as tileVideoOverlayPips'
  // own frameUrl, just for the exclusive-layout (Full-Screen/Split-Screen)
  // case, where at most one overlay is ever active per tile.
  const tileActiveExclusiveVideoOverlayFrameUrl = useMemo(() => {
    return tileActiveExclusiveVideoOverlay.map((overlay, index) =>
      overlay
        ? resolveVideoOverlayFrameUrl(
            overlay,
            thumbnailTimestampsSeconds[index],
            videoOverlayThumbnailFramesByAssetId,
            videoOverlayStartThumbnailByKey,
            videoThumbnailUrlByAssetId
          )
        : null
    );
  }, [
    tileActiveExclusiveVideoOverlay,
    thumbnailTimestampsSeconds,
    videoOverlayThumbnailFramesByAssetId,
    videoOverlayStartThumbnailByKey,
    videoThumbnailUrlByAssetId,
  ]);

  // One segment per base-sequence clip (video or image), for the Cutaways
  // rail (CutawayTrack) -- start/end time come from the same
  // clipBoundarySeconds a preceding boundary already resolves to in
  // handleBoundaryPointerUp above, so this rail's segments always line up
  // with each clip's own boundary-drag handle, for either kind.
  const cutawaySegments = useMemo<CutawaySegment[]>(() => {
    return sequenceEntries.map((entry, index) => {
      const startTimeSeconds = index === 0 ? 0 : clipBoundarySeconds[index - 1];
      const endTimeSeconds = index < clipBoundarySeconds.length ? clipBoundarySeconds[index] : durationSeconds;
      if (entry.kind === "image") {
        return {
          kind: "image" as const,
          entryId: entry.id,
          assetId: entry.assetId,
          templateIds: normalizeImageTemplateIds(entry),
          cropRect: entry.cropRect ?? null,
          startTimeSeconds,
          durationSeconds: endTimeSeconds - startTimeSeconds,
          colorFilterId: entry.colorFilterId ?? null,
          canvasFillMode: entry.canvasFillMode ?? null,
          canvasFillColor: entry.canvasFillColor,
          canvasFillGradientColor: entry.canvasFillGradientColor,
          backgroundRemoval: entry.backgroundRemoval,
        };
      }
      return {
        kind: "video" as const,
        entryId: entry.id,
        assetId: entry.assetId,
        startTimeSeconds,
        durationSeconds: endTimeSeconds - startTimeSeconds,
        colorFilterId: entry.colorFilterId ?? null,
        canvasFillMode: entry.canvasFillMode ?? null,
        canvasFillColor: entry.canvasFillColor,
        canvasFillGradientColor: entry.canvasFillGradientColor,
        backgroundRemoval: entry.backgroundRemoval,
      };
    });
  }, [sequenceEntries, clipBoundarySeconds, durationSeconds]);

  // The tile whose OWN timestamp is closest to the playhead -- NOT an
  // even-spacing index formula (see this file's module comment on why
  // that breaks for a concatenated sequence). Still only this one tile's
  // memo identity flips per tick, not all of them.
  const activeTileIndex = useMemo(
    () => findClosestTimestampIndex(thumbnailTimestampsSeconds, currentTimeSeconds),
    [thumbnailTimestampsSeconds, currentTimeSeconds]
  );

  if (thumbnails.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-2 text-xs text-muted">
        {isLoading ? "Generating thumbnails…" : "Add a video to see its timeline"}
      </div>
    );
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (durationSeconds <= 0 || !trackRef.current) return;
    // getBoundingClientRect() reflects the track's current rendered
    // position, scroll offset included -- clientX (a viewport coordinate)
    // minus rect.left is correct however far the strip has been scrolled.
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    onSeek(fraction * durationSeconds);
  }

  const playheadPercent =
    durationSeconds > 0 ? Math.min(Math.max(currentTimeSeconds / durationSeconds, 0), 1) * 100 : 0;

  return (
    <div
      ref={scrollContainerRef}
      onScroll={onScroll}
      // hide-scrollbar, same as MainAudioTrackStrip/BackgroundTrackStrip --
      // see globals.css's own comment. Playground.tsx's own proxy scrollbar
      // row (at the very bottom of the whole synced group, below both audio
      // rails) is the one visible, draggable affordance now -- an earlier
      // version put a visible scrollbar directly on this strip instead, but
      // that landed it visually between this strip and the two audio rails
      // instead of below the whole group.
      className="hide-scrollbar max-h-full overflow-x-auto bg-neutral-950 px-2"
    >
      {/* w-max so this div's own width is the strip's true total length --
          the playhead and ZoomEffectsTrack below both size/position
          relative to THIS box, so they stay aligned with the right
          thumbnail (and each other) at any scroll position. Height is
          natural (tile height + the effects track), NOT stretched to fill
          whatever space Playground.tsx allocates -- see FrameTile's
          comment for why forcing that produced unwanted blank padding. */}
      <div ref={trackRef} className="relative flex w-max flex-col">
        <MarkerTrack
          markers={markers}
          totalDurationSeconds={durationSeconds}
          snapPointsSeconds={overlaySnapPointsSeconds}
          frameThumbnails={thumbnails}
          frameThumbnailTimestampsSeconds={thumbnailTimestampsSeconds}
          onAdd={onAddMarker}
          onMove={onMoveMarker}
          onRename={onRenameMarker}
          onDelete={onDeleteMarker}
          onTogglePin={onTogglePinMarker}
        />

        <CutawayTrack
          segments={cutawaySegments}
          videoDurationSeconds={durationSeconds}
          onEdit={onEditCutaway}
          onDelete={onDeleteCutaway}
          onOpenFilter={onOpenCutawayFilter}
          onOpenCanvasFill={onOpenCutawayCanvasFill}
        />

        <TrimTrack
          trimRanges={trimRanges}
          pendingTrimStartSeconds={pendingTrimStartSeconds}
          videoDurationSeconds={durationSeconds}
          onClick={onTrimTrackClick}
          onMoveDot={onMoveTrimDot}
          onDeleteRange={onDeleteTrimRange}
        />

        {/* Compositing z-order stack starts here -- TOP = FRONTMOST in the
            rendered video (matches CanvasPlayer.tsx/exportTimeline.ts's own
            draw order). See this file's own module comment for the full
            rationale. */}
        <p className="mb-0.5 text-[9px] uppercase tracking-wide text-muted/70">Overlays -- top renders in front</p>

        <TtsOverlayTrack
          ttsOverlays={ttsOverlays}
          videoDurationSeconds={durationSeconds}
          onChangePosition={onChangeTtsOverlayPosition}
          onCommitPosition={onCommitTtsOverlayPosition}
          onChangeVolume={onChangeTtsOverlayVolume}
          onCommitVolume={onCommitTtsOverlayVolume}
          onEdit={onEditTtsOverlay}
          onDelete={onDeleteTtsOverlay}
        />

        <TextOverlayTrack
          textOverlays={textOverlays}
          videoDurationSeconds={durationSeconds}
          onChangeRange={onChangeTextOverlayRange}
          onCommitRange={onCommitTextOverlayRange}
          onEdit={onRequestEditTextOverlay}
          onDelete={onDeleteTextOverlay}
        />

        <ImageOverlayTrack
          imageOverlays={overlayImages}
          assetUrlById={assetUrlById}
          videoDurationSeconds={durationSeconds}
          snapPointsSeconds={overlaySnapPointsSeconds}
          layoutGroup="picture-in-picture"
          onChangeRange={onChangeImageOverlayRange}
          onCommitRange={onCommitImageOverlayRange}
          onChangePosition={onChangeImageOverlayPosition}
          onCommitPosition={onCommitImageOverlayPosition}
          onChangeLayout={onChangeImageOverlayLayout}
          onToggleOrientation={onToggleImageSplitScreenOrientation}
          onToggleSides={onToggleImageSplitScreenSides}
          onOpenFraming={onOpenImageOverlayFraming}
          onOpenFilter={onOpenImageOverlayFilter}
          onDelete={onDeleteImageOverlay}
        />

        <VideoOverlayTrack
          videoOverlays={videoOverlays}
          assetThumbnailUrlById={videoThumbnailUrlByAssetId}
          overlaySourceDurationSeconds={overlaySourceDurationSeconds}
          videoDurationSeconds={durationSeconds}
          snapPointsSeconds={overlaySnapPointsSeconds}
          layoutGroup="picture-in-picture"
          onChangeRange={onChangeVideoOverlayRange}
          onCommitRange={onCommitVideoOverlayRange}
          onChangePosition={onChangeVideoOverlayPosition}
          onCommitPosition={onCommitVideoOverlayPosition}
          onChangeLayout={onChangeVideoOverlayLayout}
          onToggleOrientation={onToggleSplitScreenOrientation}
          onToggleSides={onToggleSplitScreenSides}
          onOpenFraming={onOpenVideoOverlayFraming}
          onOpenFilter={onOpenVideoOverlayFilter}
          onOpenSourceStart={onOpenSourceStart}
          onDelete={onDeleteVideoOverlay}
          onChangeAudioBalance={onChangeOverlayAudioBalance}
          onCommitAudioBalance={onCommitOverlayAudioBalance}
        />

        <ImageOverlayTrack
          imageOverlays={overlayImages}
          assetUrlById={assetUrlById}
          videoDurationSeconds={durationSeconds}
          snapPointsSeconds={overlaySnapPointsSeconds}
          layoutGroup="exclusive"
          onChangeRange={onChangeImageOverlayRange}
          onCommitRange={onCommitImageOverlayRange}
          onChangePosition={onChangeImageOverlayPosition}
          onCommitPosition={onCommitImageOverlayPosition}
          onChangeLayout={onChangeImageOverlayLayout}
          onToggleOrientation={onToggleImageSplitScreenOrientation}
          onToggleSides={onToggleImageSplitScreenSides}
          onOpenFraming={onOpenImageOverlayFraming}
          onOpenFilter={onOpenImageOverlayFilter}
          onDelete={onDeleteImageOverlay}
        />

        <VideoOverlayTrack
          videoOverlays={videoOverlays}
          assetThumbnailUrlById={videoThumbnailUrlByAssetId}
          overlaySourceDurationSeconds={overlaySourceDurationSeconds}
          videoDurationSeconds={durationSeconds}
          snapPointsSeconds={overlaySnapPointsSeconds}
          layoutGroup="exclusive"
          onChangeRange={onChangeVideoOverlayRange}
          onCommitRange={onCommitVideoOverlayRange}
          onChangePosition={onChangeVideoOverlayPosition}
          onCommitPosition={onCommitVideoOverlayPosition}
          onChangeLayout={onChangeVideoOverlayLayout}
          onToggleOrientation={onToggleSplitScreenOrientation}
          onToggleSides={onToggleSplitScreenSides}
          onOpenFraming={onOpenVideoOverlayFraming}
          onOpenFilter={onOpenVideoOverlayFilter}
          onOpenSourceStart={onOpenSourceStart}
          onDelete={onDeleteVideoOverlay}
          onChangeAudioBalance={onChangeOverlayAudioBalance}
          onCommitAudioBalance={onCommitOverlayAudioBalance}
        />

        <div onClick={handleClick} className="flex cursor-pointer items-center">
          {thumbnails.map((src, index) => (
            <FrameTile
              key={index}
              src={src}
              index={index}
              widthPx={tileWidthsPx[index]}
              frameAspectRatio={frameAspectRatio}
              cropRect={tileCropRects[index]}
              flipHorizontal={tileFlips[index].flipHorizontal}
              flipVertical={tileFlips[index].flipVertical}
              isTrimmed={tileIsTrimmed[index]}
              assetUrlById={assetUrlById}
              textOverlays={tileTextOverlays[index]}
              imageOverlayPips={tileImageOverlayPips[index]}
              videoOverlayPips={tileVideoOverlayPips[index]}
              activeExclusiveImageOverlay={tileActiveExclusiveImageOverlay[index]}
              activeExclusiveVideoOverlay={tileActiveExclusiveVideoOverlay[index]}
              activeExclusiveVideoOverlayFrameUrl={tileActiveExclusiveVideoOverlayFrameUrl[index]}
              isImageClip={tileIsImageClip[index] ?? false}
              colorFilterId={tileColorFilterId[index] ?? null}
              onChange={index === activeTileIndex ? onCropRectChange : undefined}
              onCommit={index === activeTileIndex ? onCropRectCommit : undefined}
              onFlipHorizontal={index === activeTileIndex ? onFlipHorizontal : undefined}
              onFlipVertical={index === activeTileIndex ? onFlipVertical : undefined}
              onTextOverlayRectChange={index === activeTileIndex ? onChangeTextOverlayRect : undefined}
              onTextOverlayRectCommit={index === activeTileIndex ? onCommitTextOverlayRect : undefined}
              onImageOverlayRectChange={index === activeTileIndex ? onChangeImageOverlayRect : undefined}
              onImageOverlayRectCommit={index === activeTileIndex ? onCommitImageOverlayRect : undefined}
              onVideoOverlayRectChange={index === activeTileIndex ? onChangeVideoOverlayRect : undefined}
              onVideoOverlayRectCommit={index === activeTileIndex ? onCommitVideoOverlayRect : undefined}
            />
          ))}
        </div>

        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500"
          style={{ left: `${playheadPercent}%` }}
        />

        {/* One grey guide line per marker, spanning every track in this
            same scrollable column (same inset-y-0 trick the playhead line
            above uses) -- lets a marker be used to align a cutaway/overlay/
            zoom effect edge against it by eye, not just to plan a cut. */}
        {markers.map((marker, index) => (
          <div
            key={index}
            title={`Marker: ${marker.label} (${marker.timeSeconds.toFixed(1)}s)`}
            className="pointer-events-none absolute inset-y-0 w-px bg-neutral-400/70"
            style={{ left: `${durationSeconds > 0 ? (marker.timeSeconds / durationSeconds) * 100 : 0}%` }}
          />
        ))}

        {clipBoundarySeconds.map((boundarySeconds, index) => {
          const clipStartSeconds = index === 0 ? 0 : clipBoundarySeconds[index - 1];
          const isImageBoundary = sequenceEntries[index]?.kind === "image";
          const isDraggingThis = draggingBoundary?.index === index;
          const positionSeconds = isDraggingThis ? draggingBoundary.candidateSeconds : boundarySeconds;
          const leftPercent = durationSeconds > 0 ? (positionSeconds / durationSeconds) * 100 : 0;
          // The INCOMING clip of this boundary -- cutTransitionInId lives
          // on sequenceEntries[index+1], never on sequenceEntries[index]
          // (see video_math.ts's own doc comment) -- always defined since
          // clipBoundarySeconds only has one entry per SEAM (never one for
          // the very last clip's own end), so index+1 is always a real clip.
          const incomingEntry = sequenceEntries[index + 1];

          return (
            <div key={index} className="pointer-events-none absolute inset-y-0" style={{ left: `${leftPercent}%` }}>
              {isImageBoundary ? (
                <div
                  title="Drag to resize this photo clip's duration"
                  onPointerDown={(e) => handleBoundaryPointerDown(index, clipStartSeconds, boundarySeconds, e)}
                  onPointerMove={handleBoundaryPointerMove}
                  onPointerUp={handleBoundaryPointerUp}
                  className="pointer-events-auto absolute inset-y-0 flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center"
                >
                  <div className={"h-full w-0.5 " + (isDraggingThis ? "bg-accent" : "bg-accent/70")} />
                </div>
              ) : (
                <div className="absolute inset-y-0 w-px bg-white/60" />
              )}
              {incomingEntry && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenClipTransition(incomingEntry);
                  }}
                  title={incomingEntry.cutTransitionInId ? `Transition: ${incomingEntry.cutTransitionInId}` : "Transition: Cut -- click to change"}
                  className={
                    "pointer-events-auto absolute top-1 z-10 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full border " +
                    (incomingEntry.cutTransitionInId ? "border-accent bg-accent text-accent-foreground" : "border-white/60 bg-black/50 text-white/80 hover:bg-black/70")
                  }
                >
                  <CutTransitionIcon id={incomingEntry.cutTransitionInId ?? null} className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          );
        })}

        <ZoomEffectsTrack
          zoomEffects={zoomEffects}
          videoDurationSeconds={durationSeconds}
          onChangeRange={onChangeZoomRange}
          onCommitRange={onCommitZoomRange}
          onChangeEpicenter={onChangeZoomEpicenter}
          onCommitEpicenter={onCommitZoomEpicenter}
          onDeleteEffect={onDeleteZoomEffect}
        />
        <FlipTrack
          segments={flipHorizontalSegments}
          videoDurationSeconds={durationSeconds}
          colorClassName="bg-red-500/50 border border-red-500"
          title="Flipped"
          deleteLabel="Delete flip"
          onDeleteSegment={onDeleteFlipHorizontalSegment}
        />
        <FlipTrack
          segments={flipVerticalSegments}
          videoDurationSeconds={durationSeconds}
          colorClassName="bg-purple-500/50 border border-purple-500"
          title="Mirrored"
          deleteLabel="Delete mirror"
          onDeleteSegment={onDeleteFlipVerticalSegment}
        />
      </div>
    </div>
  );
}
