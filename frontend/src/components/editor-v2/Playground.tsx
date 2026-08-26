"use client";

/**
 * The middle band of the three-pane editor, top to bottom: the video
 * sequence "unfolded" into a per-second thumbnail strip (sized to its own
 * natural content height -- tile height from FrameStrip's
 * frameAspectRatio, not stretched/centered to fill whatever space is left,
 * which just produced blank padding when the video's aspect ratio didn't
 * happen to match the available height), the main sequence's own audio
 * rail immediately below it (MainAudioTrackStrip -- a solid span, not a
 * waveform; see that file's own comment on why), and the background-music
 * rail at the very bottom (concatenates every track in the sequence and
 * loops the whole thing across the video's duration, see
 * BackgroundTrackStrip) -- furthest from the main video content it plays
 * under. Both audio rails are FIXED height -- just another rail, same as
 * every other track in the strip -- with a VolumeFader pinned to their own
 * left edge (not scrolling with the rest of the rail) for setting that
 * track's volume directly, rather than a resizable panel (the previous
 * design; resizing only ever changed how much of the strip you could see,
 * it never controlled volume, and a volume control genuinely didn't exist
 * anywhere before this).
 *
 * If the three strips' combined natural height exceeds the band
 * ThreePaneEditor allocates this component, this component scrolls
 * VERTICALLY (overflow-y-auto below) rather than clipping or squeezing
 * the frame strip to fit -- the frame strip is shown at its true size or
 * not at all, never distorted to fit a slot.
 *
 * The three strips' own scrollable content represents the same timeline at
 * the same PIXELS_PER_SECOND scale (so their total widths line up) and
 * share one HORIZONTAL scroll position via lib/useSyncedHorizontalScroll.ts
 * -- scrolling any one of them scrolls all three together, since they're
 * meant to read as one aligned view of the clip, not three
 * independently-scrolling panels that happen to be stacked. The two
 * VolumeFaders sit outside that synced-scroll area (they're fixed controls,
 * not part of the timeline itself).
 */
import { BackgroundTrackStrip } from "./BackgroundTrackStrip";
import { FrameStrip } from "./FrameStrip";
import { MainAudioTrackStrip } from "./MainAudioTrackStrip";
import { VolumeFader } from "./VolumeFader";
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
import type { TimelineMarker } from "@/lib/projects";

// Fixed height for both audio rails -- same tier as every other rail in the
// strip (TrimTrack's h-4, VideoOverlayTrack's h-5, ...), not resizable.
const AUDIO_RAIL_HEIGHT_PX = 16;
// Fixed width for the VolumeFader pinned to each audio rail's own left
// edge -- wide enough to be a comfortable drag target without eating much
// of the strip's own horizontal space.
const VOLUME_FADER_WIDTH_PX = 96;

// Shared time-to-pixel scale for all three strips -- see this file's
// module comment.
const PIXELS_PER_SECOND = 60;

const BACKGROUND_STRIP_INDEX = 0;
const FRAME_STRIP_INDEX = 1;
const MAIN_AUDIO_STRIP_INDEX = 2;

export function Playground({
  backgroundTracks,
  videoDurationSeconds,
  thumbnails,
  thumbnailTimestampsSeconds,
  clipBoundarySeconds,
  sequenceEntries,
  onResizeImageClip,
  mainAudioVolume,
  onChangeMainAudioVolume,
  backgroundVolume,
  onChangeBackgroundVolume,
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
  markers,
  onAddMarker,
  onMoveMarker,
  onRenameMarker,
  onDeleteMarker,
  onOpenSourceStart,
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
  mainAudioVolume: number;
  onChangeMainAudioVolume: (level: number) => void;
  backgroundVolume: number;
  onChangeBackgroundVolume: (level: number) => void;
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
  markers: TimelineMarker[];
  onAddMarker: (timeSeconds: number) => void;
  onMoveMarker: (index: number, timeSeconds: number) => void;
  onRenameMarker: (index: number, label: string) => void;
  onDeleteMarker: (index: number) => void;
  // The flag icon on a VideoOverlayTrack segment -- opens
  // OverlaySourceStartDialog for that specific overlay placement.
  onOpenSourceStart: (overlayIndex: number) => void;
}) {
  const { bindRef, bindOnScroll } = useSyncedHorizontalScroll(3);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface px-2">
      {/* One seamless panel (shared bg-neutral-950, no gap between rows) --
          the frame strip and the two audio rails all represent one
          continuous timeline (see this file's own module comment) and
          should read as one panel, not three separate floating cards. The
          primary reel audio sits immediately below the frames it's the
          sound for; background music sits at the very bottom, furthest
          from the main video content it plays under. */}
      <div className="flex flex-col rounded-md bg-neutral-950">
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
            markers={markers}
            onAddMarker={onAddMarker}
            onMoveMarker={onMoveMarker}
            onRenameMarker={onRenameMarker}
            onDeleteMarker={onDeleteMarker}
            onOpenSourceStart={onOpenSourceStart}
            pixelsPerSecond={PIXELS_PER_SECOND}
            scrollContainerRef={bindRef(FRAME_STRIP_INDEX)}
            onScroll={bindOnScroll(FRAME_STRIP_INDEX)}
          />
        </div>

        <div className="flex shrink-0 gap-1" style={{ height: AUDIO_RAIL_HEIGHT_PX }}>
          <div className="shrink-0" style={{ width: VOLUME_FADER_WIDTH_PX }}>
            <VolumeFader
              value={mainAudioVolume}
              onChange={onChangeMainAudioVolume}
              colorClassName="to-amber-500"
              className="h-full w-full"
            />
          </div>
          <div className="min-w-0 flex-1">
            <MainAudioTrackStrip
              videoDurationSeconds={videoDurationSeconds}
              pixelsPerSecond={PIXELS_PER_SECOND}
              scrollContainerRef={bindRef(MAIN_AUDIO_STRIP_INDEX)}
              onScroll={bindOnScroll(MAIN_AUDIO_STRIP_INDEX)}
            />
          </div>
        </div>

        <div className="flex shrink-0 gap-1" style={{ height: AUDIO_RAIL_HEIGHT_PX }}>
          <div className="shrink-0" style={{ width: VOLUME_FADER_WIDTH_PX }}>
            <VolumeFader
              value={backgroundVolume}
              onChange={onChangeBackgroundVolume}
              colorClassName="to-accent"
              className="h-full w-full"
            />
          </div>
          <div className="min-w-0 flex-1">
            <BackgroundTrackStrip
              tracks={backgroundTracks}
              videoDurationSeconds={videoDurationSeconds}
              pixelsPerSecond={PIXELS_PER_SECOND}
              scrollContainerRef={bindRef(BACKGROUND_STRIP_INDEX)}
              onScroll={bindOnScroll(BACKGROUND_STRIP_INDEX)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
