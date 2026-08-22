"use client";

/**
 * The middle band of the three-pane editor: the video "unfolded" into a
 * per-second thumbnail strip, with a sound volume graph beneath it. Both are
 * wrapped in their own ResizablePanel so each can be resized independently
 * by dragging its top notch -- the two panels don't share a single split, by
 * design, since resizing the image sequence and controlling the volume
 * graph's height are separate user actions per spec.
 */
import { ResizablePanel } from "./ResizablePanel";
import { FrameStrip } from "./FrameStrip";
import { VolumeGraph } from "./VolumeGraph";

// Initial heights before any resizing -- the +/-25% stretch range (see
// video_math.ts's DEFAULT_MAX_STRETCH_RATIO) is computed relative to these.
const INITIAL_FRAME_STRIP_HEIGHT_PX = 120;
const INITIAL_VOLUME_GRAPH_HEIGHT_PX = 80;

export function Playground({
  thumbnails,
  volumeLevels,
  isAnalyzing,
}: {
  thumbnails: string[];
  volumeLevels: number[];
  isAnalyzing: boolean;
}) {
  return (
    <div className="flex h-full flex-col justify-center gap-2 bg-surface px-2">
      <ResizablePanel label="image sequence" initialHeightPx={INITIAL_FRAME_STRIP_HEIGHT_PX}>
        <FrameStrip thumbnails={thumbnails} isLoading={isAnalyzing} />
      </ResizablePanel>
      <ResizablePanel label="sound volume" initialHeightPx={INITIAL_VOLUME_GRAPH_HEIGHT_PX}>
        <VolumeGraph levels={volumeLevels} isLoading={isAnalyzing} />
      </ResizablePanel>
    </div>
  );
}
