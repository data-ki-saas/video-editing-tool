"use client";

/**
 * The middle band of the three-pane editor, top to bottom: the video
 * sequence "unfolded" into a per-second thumbnail strip -- itself preceded
 * by its own stack of rails (MarkerTrack, the Cutaways rail, the Cut and
 * Trim rail; see FrameStrip's own module comment for the full stacking
 * order) -- sized to its own natural content height -- tile height from
 * FrameStrip's
 * frameAspectRatio, not stretched/centered to fill whatever space is left,
 * which just produced blank padding when the video's aspect ratio didn't
 * happen to match the available height), the main sequence's own audio
 * rail immediately below it (MainAudioTrackStrip -- a solid span, not a
 * waveform; see that file's own comment on why), and the background-music
 * rail at the very bottom (concatenates every track in the sequence and
 * loops the whole thing across the video's duration, see
 * BackgroundTrackStrip) -- furthest from the main video content it plays
 * under. Both audio rails are FIXED height -- just another rail, same as
 * every other track in the strip -- with a rail-identity icon (MicrophoneIcon
 * for MainAudioTrackStrip, MusicNoteIcon for BackgroundTrackStrip -- see
 * @/components/icons/UIIcons) followed by a VolumeBadge (see
 * ./VolumeBadge.tsx) overlaid on their own left edge, in that order, for
 * telling the two rails apart at a glance and setting that track's volume
 * directly, rather than a resizable panel (the previous
 * design; resizing only ever changed how much of the strip you could see,
 * it never controlled volume, and a volume control genuinely didn't exist
 * anywhere before this). An earlier version used a horizontal VolumeFader
 * in its own fixed-width column beside the rail instead of an overlaid
 * badge -- that column offset the rail's own content start from
 * FrameStrip's, so the same instant landed at two different x positions
 * depending which strip you looked at (and a click on the audio rail
 * didn't seek to where it visually looked like it would). A badge takes
 * only its own small footprint, so all three strips' content now starts at
 * the same x=0.
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
 * VolumeBadges sit outside that synced-scroll area (they're fixed
 * controls, not part of the timeline itself) -- they're overlaid, not
 * absent from layout flow entirely, so they stay visible regardless of
 * scroll position.
 *
 * All three strips hide their own native scrollbar (`hide-scrollbar`, see
 * globals.css) -- a fourth synced element, a thin proxy scrollbar row below
 * BackgroundTrackStrip (the last rail), supplies the one visible, draggable
 * scrollbar for the whole group instead. Putting it below every rail rather
 * than on any one of them keeps the group reading as one panel: a
 * scrollbar directly on FrameStrip (an earlier version of this) sat
 * visually between it and the two audio rails, splitting the "one seamless
 * panel" apart.
 */
import { BackgroundTrackStrip } from "./BackgroundTrackStrip";
import { FrameStrip } from "./FrameStrip";
import { MainAudioTrackStrip } from "./MainAudioTrackStrip";
import { VolumeBadge } from "./VolumeBadge";
import { MicrophoneIcon, MusicNoteIcon } from "@/components/icons/UIIcons";
import type { CutawaySegment } from "./CutawayTrack";
import { useSyncedHorizontalScroll } from "@/lib/useSyncedHorizontalScroll";
import type {
  CropRect,
  ImageOverlayClip,
  SequenceEntry,
  TextOverlay,
  TrimRange,
  TtsOverlay,
  VideoOverlayClip,
  VideoOverlayLayout,
  ZoomEffect,
} from "@/lib/video/video_math";
import type { TimelineMarker } from "@/lib/projects";

// Fixed height for the main audio rail -- same tier as every other rail in
// the strip (TrimTrack's h-4, VideoOverlayTrack's h-5, ...), not resizable.
const AUDIO_RAIL_HEIGHT_PX = 16;
// The background rail is taller than that -- unlike every other rail, its
// segments need to show the track's own name and a remove button directly
// on the segment (see BackgroundTrackStrip's own comment on why that's the
// only real way to swap background music, since Add always appends to a
// queue rather than replacing).
const BACKGROUND_RAIL_HEIGHT_PX = 28;
// Height of the proxy scrollbar row below BackgroundTrackStrip -- just
// enough for a comfortable drag target for the thin themed scrollbar
// (globals.css's own `* { scrollbar-width: thin }`), not a full rail tier.
const PROXY_SCROLLBAR_HEIGHT_PX = 10;

// Shared time-to-pixel scale for all three strips -- see this file's
// module comment. 120 (not 60) so a 1-second thumbnail tile on FrameStrip
// (THUMBNAIL_INTERVAL_SECONDS in ThreePaneEditor.tsx) renders at least
// 120px wide -- comfortably visible/selectable, not a sliver -- since
// every other strip is deliberately locked to this same scale, bumping it
// zooms the whole timeline in together rather than only FrameStrip.
const PIXELS_PER_SECOND = 120;

const BACKGROUND_STRIP_INDEX = 0;
const FRAME_STRIP_INDEX = 1;
const MAIN_AUDIO_STRIP_INDEX = 2;
const PROXY_SCROLLBAR_INDEX = 3;

export function Playground({
  backgroundTracks,
  onRemoveBackgroundTrack,
  videoDurationSeconds,
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
  markers,
  onAddMarker,
  onMoveMarker,
  onRenameMarker,
  onDeleteMarker,
  onTogglePinMarker,
  onOpenSourceStart,
}: {
  backgroundTracks: { assetId: string | null; name: string; url: string }[];
  onRemoveBackgroundTrack: (assetId: string) => void;
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
  // The Cutaways rail's own click -- see FrameStrip's own prop comment.
  onEditCutaway: (segment: CutawaySegment) => void;
  onDeleteCutaway: (segment: CutawaySegment) => void;
  onOpenCutawayFilter: (segment: CutawaySegment) => void;
  onOpenCutawayCanvasFill: (segment: CutawaySegment) => void;
  onOpenClipTransition: (entry: SequenceEntry) => void;
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
  // A still frame captured at each overlay placement's own sourceStartSeconds
  // (flag icon) -- keyed by videoOverlayStartThumbnailKey(assetId,
  // sourceStartSeconds), preferred over videoThumbnailUrlByAssetId above when
  // present so the main track shows the overlay starting from its marked
  // point. See ThreePaneEditor.tsx's own comment on the state this reads.
  videoOverlayStartThumbnailByKey: Record<string, string>;
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
  onOpenVideoOverlayFilter: (overlayIndex: number) => void;
  onDeleteVideoOverlay: (overlayIndex: number) => void;
  onChangeOverlayAudioBalance: (overlayIndex: number, balance: number) => void;
  onCommitOverlayAudioBalance: (overlayIndex: number, balance: number) => void;
  markers: TimelineMarker[];
  onAddMarker: (timeSeconds: number) => void;
  onMoveMarker: (index: number, timeSeconds: number) => void;
  onRenameMarker: (index: number, label: string) => void;
  onDeleteMarker: (index: number) => void;
  onTogglePinMarker: (index: number) => void;
  // The flag icon on a VideoOverlayTrack segment -- opens
  // OverlaySourceStartDialog for that specific overlay placement.
  onOpenSourceStart: (overlayIndex: number) => void;
}) {
  const { bindRef, bindOnScroll } = useSyncedHorizontalScroll(4);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface px-2">
      {/* One shared panel (shared bg-neutral-950) -- the frame strip and the
          two audio rails all represent one continuous timeline (see this
          file's own module comment) and should read as one panel, not
          three separate floating cards. A small gap sits between the frame
          strip and the audio rails below (see mt-2 further down) so the
          video content doesn't visually run into the audio rails -- the
          two audio rails themselves stay flush against each other, since
          together they represent one "audio" concept (reel sound, then
          background music under it). The primary reel audio sits
          immediately below the frames it's the sound for; background music
          sits at the very bottom, furthest from the main video content it
          plays under. */}
      <div className="flex flex-col rounded-md bg-neutral-950">
        <div className="shrink-0">
          <FrameStrip
            thumbnails={thumbnails}
            thumbnailTimestampsSeconds={thumbnailTimestampsSeconds}
            clipBoundarySeconds={clipBoundarySeconds}
            sequenceEntries={sequenceEntries}
            onResizeImageClip={onResizeImageClip}
            onEditCutaway={onEditCutaway}
            onOpenCutawayFilter={onOpenCutawayFilter}
            onOpenCutawayCanvasFill={onOpenCutawayCanvasFill}
            onOpenClipTransition={onOpenClipTransition}
            onDeleteCutaway={onDeleteCutaway}
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
            onChangeImageOverlayRect={onChangeImageOverlayRect}
            onCommitImageOverlayRect={onCommitImageOverlayRect}
            onChangeImageOverlayRange={onChangeImageOverlayRange}
            onCommitImageOverlayRange={onCommitImageOverlayRange}
            onChangeImageOverlayPosition={onChangeImageOverlayPosition}
            onCommitImageOverlayPosition={onCommitImageOverlayPosition}
            onChangeImageOverlayLayout={onChangeImageOverlayLayout}
            onToggleImageSplitScreenOrientation={onToggleImageSplitScreenOrientation}
            onToggleImageSplitScreenSides={onToggleImageSplitScreenSides}
            onOpenImageOverlayFraming={onOpenImageOverlayFraming}
            onOpenImageOverlayFilter={onOpenImageOverlayFilter}
            onDeleteImageOverlay={onDeleteImageOverlay}
            textOverlays={textOverlays}
            onChangeTextOverlayRect={onChangeTextOverlayRect}
            onCommitTextOverlayRect={onCommitTextOverlayRect}
            onChangeTextOverlayRange={onChangeTextOverlayRange}
            onCommitTextOverlayRange={onCommitTextOverlayRange}
            onDeleteTextOverlay={onDeleteTextOverlay}
            onRequestEditTextOverlay={onRequestEditTextOverlay}
            ttsOverlays={ttsOverlays}
            onChangeTtsOverlayPosition={onChangeTtsOverlayPosition}
            onCommitTtsOverlayPosition={onCommitTtsOverlayPosition}
            onChangeTtsOverlayVolume={onChangeTtsOverlayVolume}
            onCommitTtsOverlayVolume={onCommitTtsOverlayVolume}
            onEditTtsOverlay={onEditTtsOverlay}
            onDeleteTtsOverlay={onDeleteTtsOverlay}
            videoOverlays={videoOverlays}
            videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
            videoOverlayStartThumbnailByKey={videoOverlayStartThumbnailByKey}
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
            onOpenVideoOverlayFilter={onOpenVideoOverlayFilter}
            onDeleteVideoOverlay={onDeleteVideoOverlay}
            onChangeOverlayAudioBalance={onChangeOverlayAudioBalance}
            onCommitOverlayAudioBalance={onCommitOverlayAudioBalance}
            markers={markers}
            onAddMarker={onAddMarker}
            onMoveMarker={onMoveMarker}
            onRenameMarker={onRenameMarker}
            onDeleteMarker={onDeleteMarker}
            onTogglePinMarker={onTogglePinMarker}
            onOpenSourceStart={onOpenSourceStart}
            pixelsPerSecond={PIXELS_PER_SECOND}
            scrollContainerRef={bindRef(FRAME_STRIP_INDEX)}
            onScroll={bindOnScroll(FRAME_STRIP_INDEX)}
          />
        </div>

        <div className="relative mt-2 shrink-0" style={{ height: AUDIO_RAIL_HEIGHT_PX }}>
          <div className="absolute left-0.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5">
            <span
              title="This reel's own captured sound"
              className="flex shrink-0 items-center justify-center rounded-sm bg-black/25 p-0.5 text-white"
            >
              <MicrophoneIcon className="h-2.5 w-2.5" />
            </span>
            <VolumeBadge
              value={mainAudioVolume}
              onChange={onChangeMainAudioVolume}
              onCommit={onChangeMainAudioVolume}
              colorClassName="to-amber-500"
            />
          </div>
          <MainAudioTrackStrip
            videoDurationSeconds={videoDurationSeconds}
            pixelsPerSecond={PIXELS_PER_SECOND}
            currentTimeSeconds={currentTimeSeconds}
            onSeek={onSeek}
            scrollContainerRef={bindRef(MAIN_AUDIO_STRIP_INDEX)}
            onScroll={bindOnScroll(MAIN_AUDIO_STRIP_INDEX)}
          />
        </div>

        <div className="relative shrink-0" style={{ height: BACKGROUND_RAIL_HEIGHT_PX }}>
          <div className="absolute left-0.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5">
            <span
              title="Background music"
              className="flex shrink-0 items-center justify-center rounded-sm bg-black/25 p-0.5 text-white"
            >
              <MusicNoteIcon className="h-2.5 w-2.5" />
            </span>
            <VolumeBadge
              value={backgroundVolume}
              onChange={onChangeBackgroundVolume}
              onCommit={onChangeBackgroundVolume}
              colorClassName="to-accent"
            />
          </div>
          <BackgroundTrackStrip
            tracks={backgroundTracks}
            onRemoveTrack={onRemoveBackgroundTrack}
            videoDurationSeconds={videoDurationSeconds}
            pixelsPerSecond={PIXELS_PER_SECOND}
            scrollContainerRef={bindRef(BACKGROUND_STRIP_INDEX)}
            onScroll={bindOnScroll(BACKGROUND_STRIP_INDEX)}
          />
        </div>

        {/* Proxy scrollbar for the whole synced group -- see this file's
            own module comment. No visible content of its own, just a
            spacer matching the other strips' own total width so its
            native scrollbar's thumb size/travel matches theirs exactly. */}
        <div
          ref={bindRef(PROXY_SCROLLBAR_INDEX)}
          onScroll={bindOnScroll(PROXY_SCROLLBAR_INDEX)}
          className="shrink-0 overflow-x-auto overflow-y-hidden rounded-b-md bg-neutral-950 px-2"
          style={{ height: PROXY_SCROLLBAR_HEIGHT_PX }}
          title="Scroll the timeline"
        >
          <div style={{ width: videoDurationSeconds * PIXELS_PER_SECOND, height: 1 }} />
        </div>
      </div>
    </div>
  );
}
