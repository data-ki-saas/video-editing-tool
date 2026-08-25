"use client";

/**
 * The middle band of the three-pane editor, top to bottom: the background-
 * music strip (pinned to the top, resizable by dragging its bottom edge --
 * concatenates every track in the sequence and loops the whole thing
 * across the video's duration, see BackgroundTrackStrip), the video
 * sequence "unfolded" into a per-second thumbnail strip (sized to its own
 * natural content height -- tile height from FrameStrip's frameAspectRatio,
 * not stretched/centered to fill whatever space is left, which just
 * produced blank padding when the video's aspect ratio didn't happen to
 * match the available height), and a sound volume graph (pinned to the
 * bottom, resizable by dragging its top edge). See ResizablePanel.tsx's
 * `anchor` prop for how the background/volume panels each stay pinned to
 * their own edge of the stack while still being independently resizable.
 *
 * If the three strips' combined natural height exceeds the band
 * ThreePaneEditor allocates this component, this component scrolls
 * VERTICALLY (overflow-y-auto below) rather than clipping or squeezing
 * the frame strip to fit -- the frame strip is shown at its true size or
 * not at all, never distorted to fit a slot.
 *
 * All three strips represent the same timeline at the same
 * PIXELS_PER_SECOND scale (so their total widths line up) and share one
 * HORIZONTAL scroll position via lib/useSyncedHorizontalScroll.ts --
 * scrolling any one of them scrolls all three together, since they're
 * meant to read as one aligned view of the clip, not three
 * independently-scrolling panels that happen to be stacked.
 */
import { ResizablePanel } from "./ResizablePanel";
import { BackgroundTrackStrip } from "./BackgroundTrackStrip";
import { FrameStrip } from "./FrameStrip";
import { VolumeGraph } from "./VolumeGraph";
import { useSyncedHorizontalScroll } from "@/lib/useSyncedHorizontalScroll";
import type {
  CropRect,
  OverlayImage,
  SequenceEntry,
  TextOverlay,
  TrimRange,
  VideoOverlayClip,
  VideoOverlayLayout,
  ZoomEffect,
} from "@/lib/video/video_math";

// Initial heights before any resizing -- the +/-25% stretch range (see
// video_math.ts's DEFAULT_MAX_STRETCH_RATIO) is computed relative to these.
const INITIAL_BACKGROUND_STRIP_HEIGHT_PX = 40;
const INITIAL_VOLUME_GRAPH_HEIGHT_PX = 80;

// Shared time-to-pixel scale for all three strips -- see this file's
// module comment.
const PIXELS_PER_SECOND = 60;

const BACKGROUND_STRIP_INDEX = 0;
const FRAME_STRIP_INDEX = 1;
const VOLUME_GRAPH_INDEX = 2;

export function Playground({
  backgroundTracks,
  videoDurationSeconds,
  thumbnails,
  thumbnailTimestampsSeconds,
  clipBoundarySeconds,
  sequenceEntries,
  onResizeImageClip,
  volumeLevels,
  isAnalyzing,
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
  trimRanges,
  pendingTrimStartSeconds,
  onTrimTrackClick,
  onMoveTrimDot,
  onDeleteTrimRange,
  overlayImages,
  assetUrlById,
  onChangeOverlayRect,
  onCommitOverlayRect,
  onChangeOverlayRange,
  onCommitOverlayRange,
  onDeleteOverlay,
  textOverlays,
  onChangeTextOverlayRect,
  onCommitTextOverlayRect,
  onChangeTextOverlayRange,
  onCommitTextOverlayRange,
  onDeleteTextOverlay,
  onRequestEditTextOverlay,
  videoOverlays,
  videoThumbnailUrlByAssetId,
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
  onDeleteVideoOverlay,
  onChangeOverlayAudioBalance,
  onCommitOverlayAudioBalance,
}: {
  backgroundTracks: { name: string; url: string }[];
  videoDurationSeconds: number;
  thumbnails: string[];
  thumbnailTimestampsSeconds: number[];
  clipBoundarySeconds: number[];
  // In-order metadata for each clip in the sequence (aligned with the
  // groupings clipBoundarySeconds divides) -- FrameStrip uses this to know
  // which clip-boundary marker belongs to an image clip (and so should be
  // its own drag handle) vs. an ordinary video seam (a plain divider).
  sequenceEntries: SequenceEntry[];
  onResizeImageClip: (entryId: string, newDurationSeconds: number, clipStartSeconds: number) => void;
  volumeLevels: number[];
  isAnalyzing: boolean;
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
  trimRanges: TrimRange[];
  pendingTrimStartSeconds: number | null;
  onTrimTrackClick: (timeSeconds: number) => void;
  onMoveTrimDot: (timeSeconds: number) => void;
  onDeleteTrimRange: (rangeIndex: number) => void;
  overlayImages: OverlayImage[];
  assetUrlById: Record<string, string>;
  onChangeOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onCommitOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onChangeOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onDeleteOverlay: (overlayIndex: number) => void;
  textOverlays: TextOverlay[];
  onChangeTextOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onCommitTextOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onChangeTextOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitTextOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onDeleteTextOverlay: (overlayIndex: number) => void;
  onRequestEditTextOverlay: (overlayIndex: number) => void;
  videoOverlays: VideoOverlayClip[];
  videoThumbnailUrlByAssetId: Record<string, string>;
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
  onDeleteVideoOverlay: (overlayIndex: number) => void;
  onChangeOverlayAudioBalance: (overlayIndex: number, balance: number) => void;
  onCommitOverlayAudioBalance: (overlayIndex: number, balance: number) => void;
}) {
  const { bindRef, bindOnScroll } = useSyncedHorizontalScroll(3);

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto bg-surface px-2">
      <ResizablePanel label="background track" anchor="top" initialHeightPx={INITIAL_BACKGROUND_STRIP_HEIGHT_PX}>
        <BackgroundTrackStrip
          tracks={backgroundTracks}
          videoDurationSeconds={videoDurationSeconds}
          pixelsPerSecond={PIXELS_PER_SECOND}
          scrollContainerRef={bindRef(BACKGROUND_STRIP_INDEX)}
          onScroll={bindOnScroll(BACKGROUND_STRIP_INDEX)}
        />
      </ResizablePanel>

      <div className="shrink-0">
        <FrameStrip
          thumbnails={thumbnails}
          thumbnailTimestampsSeconds={thumbnailTimestampsSeconds}
          clipBoundarySeconds={clipBoundarySeconds}
          sequenceEntries={sequenceEntries}
          onResizeImageClip={onResizeImageClip}
          isLoading={isAnalyzing}
          durationSeconds={videoDurationSeconds}
          currentTimeSeconds={currentTimeSeconds}
          onSeek={onSeek}
          baseCropRect={baseCropRect}
          zoomEffects={zoomEffects}
          frameAspectRatio={frameAspectRatio}
          onChangeZoomRange={onChangeZoomRange}
          onCommitZoomRange={onCommitZoomRange}
          onChangeZoomEpicenter={onChangeZoomEpicenter}
          onCommitZoomEpicenter={onCommitZoomEpicenter}
          onDeleteZoomEffect={onDeleteZoomEffect}
          onCropRectChange={onCropRectChange}
          onCropRectCommit={onCropRectCommit}
          flipHorizontalToggles={flipHorizontalToggles}
          flipVerticalToggles={flipVerticalToggles}
          onFlipHorizontal={onFlipHorizontal}
          onFlipVertical={onFlipVertical}
          trimRanges={trimRanges}
          pendingTrimStartSeconds={pendingTrimStartSeconds}
          onTrimTrackClick={onTrimTrackClick}
          onMoveTrimDot={onMoveTrimDot}
          onDeleteTrimRange={onDeleteTrimRange}
          overlayImages={overlayImages}
          assetUrlById={assetUrlById}
          onChangeOverlayRect={onChangeOverlayRect}
          onCommitOverlayRect={onCommitOverlayRect}
          onChangeOverlayRange={onChangeOverlayRange}
          onCommitOverlayRange={onCommitOverlayRange}
          onDeleteOverlay={onDeleteOverlay}
          textOverlays={textOverlays}
          onChangeTextOverlayRect={onChangeTextOverlayRect}
          onCommitTextOverlayRect={onCommitTextOverlayRect}
          onChangeTextOverlayRange={onChangeTextOverlayRange}
          onCommitTextOverlayRange={onCommitTextOverlayRange}
          onDeleteTextOverlay={onDeleteTextOverlay}
          onRequestEditTextOverlay={onRequestEditTextOverlay}
          videoOverlays={videoOverlays}
          videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
          overlaySourceDurationSeconds={overlaySourceDurationSeconds}
          onChangeVideoOverlayRect={onChangeVideoOverlayRect}
          onCommitVideoOverlayRect={onCommitVideoOverlayRect}
          onChangeVideoOverlayRange={onChangeVideoOverlayRange}
          onCommitVideoOverlayRange={onCommitVideoOverlayRange}
          onChangeVideoOverlayPosition={onChangeVideoOverlayPosition}
          onCommitVideoOverlayPosition={onCommitVideoOverlayPosition}
          onChangeVideoOverlayLayout={onChangeVideoOverlayLayout}
          onToggleSplitScreenOrientation={onToggleSplitScreenOrientation}
          onToggleSplitScreenSides={onToggleSplitScreenSides}
          onOpenVideoOverlayFraming={onOpenVideoOverlayFraming}
          onDeleteVideoOverlay={onDeleteVideoOverlay}
          onChangeOverlayAudioBalance={onChangeOverlayAudioBalance}
          onCommitOverlayAudioBalance={onCommitOverlayAudioBalance}
          pixelsPerSecond={PIXELS_PER_SECOND}
          scrollContainerRef={bindRef(FRAME_STRIP_INDEX)}
          onScroll={bindOnScroll(FRAME_STRIP_INDEX)}
        />
      </div>

      <ResizablePanel label="sound volume" anchor="bottom" initialHeightPx={INITIAL_VOLUME_GRAPH_HEIGHT_PX}>
        <VolumeGraph
          levels={volumeLevels}
          isLoading={isAnalyzing}
          pixelsPerSecond={PIXELS_PER_SECOND}
          scrollContainerRef={bindRef(VOLUME_GRAPH_INDEX)}
          onScroll={bindOnScroll(VOLUME_GRAPH_INDEX)}
        />
      </ResizablePanel>
    </div>
  );
}
