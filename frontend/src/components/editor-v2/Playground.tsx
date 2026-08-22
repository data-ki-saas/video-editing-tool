"use client";

/**
 * The middle band of the three-pane editor, top to bottom: the selected
 * background track's repeating strip (pinned to the top, resizable by
 * dragging its bottom edge), the video "unfolded" into a per-second
 * thumbnail strip (fills whatever space is left between the other two --
 * it doesn't compete for a fixed share, so shrinking either of them hands
 * it straight back to the frame strip), and a sound volume graph (pinned
 * to the bottom, resizable by dragging its top edge). See
 * ResizablePanel.tsx's `anchor` prop for how the background/volume panels
 * each stay pinned to their own edge of the stack while still being
 * independently resizable.
 */
import { ResizablePanel } from "./ResizablePanel";
import { BackgroundTrackStrip } from "./BackgroundTrackStrip";
import { FrameStrip } from "./FrameStrip";
import { VolumeGraph } from "./VolumeGraph";
import type { CropRect, ZoomEffect } from "@/lib/video/video_math";

// Initial heights before any resizing -- the +/-25% stretch range (see
// video_math.ts's DEFAULT_MAX_STRETCH_RATIO) is computed relative to these.
const INITIAL_BACKGROUND_STRIP_HEIGHT_PX = 40;
const INITIAL_VOLUME_GRAPH_HEIGHT_PX = 80;

export function Playground({
  selectedBackgroundTrackId,
  videoDurationSeconds,
  thumbnails,
  volumeLevels,
  isAnalyzing,
  currentTimeSeconds,
  onSeek,
  baseCropRect,
  zoomEffect,
  onChangeZoomRange,
  onCommitZoomRange,
  onCropRectChange,
  onCropRectCommit,
}: {
  selectedBackgroundTrackId: string;
  videoDurationSeconds: number;
  thumbnails: string[];
  volumeLevels: number[];
  isAnalyzing: boolean;
  currentTimeSeconds: number;
  onSeek: (seconds: number) => void;
  baseCropRect: CropRect | null;
  zoomEffect: ZoomEffect | null;
  onChangeZoomRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitZoomRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onCropRectChange: (next: CropRect) => void;
  onCropRectCommit: (next: CropRect) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-2 bg-surface px-2">
      <ResizablePanel label="background track" anchor="top" initialHeightPx={INITIAL_BACKGROUND_STRIP_HEIGHT_PX}>
        <BackgroundTrackStrip
          selectedTrackId={selectedBackgroundTrackId}
          videoDurationSeconds={videoDurationSeconds}
        />
      </ResizablePanel>

      <div className="min-h-0 flex-1">
        <FrameStrip
          thumbnails={thumbnails}
          isLoading={isAnalyzing}
          durationSeconds={videoDurationSeconds}
          currentTimeSeconds={currentTimeSeconds}
          onSeek={onSeek}
          baseCropRect={baseCropRect}
          zoomEffect={zoomEffect}
          onChangeZoomRange={onChangeZoomRange}
          onCommitZoomRange={onCommitZoomRange}
          onCropRectChange={onCropRectChange}
          onCropRectCommit={onCropRectCommit}
        />
      </div>

      <ResizablePanel label="sound volume" anchor="bottom" initialHeightPx={INITIAL_VOLUME_GRAPH_HEIGHT_PX}>
        <VolumeGraph levels={volumeLevels} isLoading={isAnalyzing} />
      </ResizablePanel>
    </div>
  );
}
