"use client";

/**
 * The middle band of the three-pane editor, top to bottom: the selected
 * background track's repeating strip, the video "unfolded" into a
 * per-second thumbnail strip (which doubles as a scrub timeline for
 * CanvasPlayer), and a sound volume graph. Each is wrapped in its own
 * ResizablePanel so it can be resized independently by dragging its top
 * notch -- the three panels don't share a single split, by design, since
 * resizing each is a separate user action per spec.
 */
import { ResizablePanel } from "./ResizablePanel";
import { BackgroundTrackStrip } from "./BackgroundTrackStrip";
import { FrameStrip } from "./FrameStrip";
import { VolumeGraph } from "./VolumeGraph";

// Initial heights before any resizing -- the +/-25% stretch range (see
// video_math.ts's DEFAULT_MAX_STRETCH_RATIO) is computed relative to these.
const INITIAL_BACKGROUND_STRIP_HEIGHT_PX = 40;
const INITIAL_FRAME_STRIP_HEIGHT_PX = 120;
const INITIAL_VOLUME_GRAPH_HEIGHT_PX = 80;

export function Playground({
  selectedBackgroundTrackId,
  videoDurationSeconds,
  thumbnails,
  volumeLevels,
  isAnalyzing,
  currentTimeSeconds,
  onSeek,
}: {
  selectedBackgroundTrackId: string;
  videoDurationSeconds: number;
  thumbnails: string[];
  volumeLevels: number[];
  isAnalyzing: boolean;
  currentTimeSeconds: number;
  onSeek: (seconds: number) => void;
}) {
  return (
    <div className="flex h-full flex-col justify-center gap-2 bg-surface px-2">
      <ResizablePanel label="background track" initialHeightPx={INITIAL_BACKGROUND_STRIP_HEIGHT_PX}>
        <BackgroundTrackStrip
          selectedTrackId={selectedBackgroundTrackId}
          videoDurationSeconds={videoDurationSeconds}
        />
      </ResizablePanel>
      <ResizablePanel label="image sequence" initialHeightPx={INITIAL_FRAME_STRIP_HEIGHT_PX}>
        <FrameStrip
          thumbnails={thumbnails}
          isLoading={isAnalyzing}
          durationSeconds={videoDurationSeconds}
          currentTimeSeconds={currentTimeSeconds}
          onSeek={onSeek}
        />
      </ResizablePanel>
      <ResizablePanel label="sound volume" initialHeightPx={INITIAL_VOLUME_GRAPH_HEIGHT_PX}>
        <VolumeGraph levels={volumeLevels} isLoading={isAnalyzing} />
      </ResizablePanel>
    </div>
  );
}
