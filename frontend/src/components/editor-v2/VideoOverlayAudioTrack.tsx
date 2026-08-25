"use client";

/**
 * One rail, directly above VideoOverlayTrack, showing which audio plays
 * during each video overlay's own window and letting you drag a mix
 * handle to balance it -- see video_math.ts's VideoOverlayClip.audioBalance
 * (0 = only the base clip's own audio, 1 = only the overlay's, in between
 * mixes both at that fraction of their own volume). Each segment's time
 * window is FIXED to its video overlay's own (this rail never
 * moves/resizes anything, only the balance within a segment) -- uses the
 * exact same two-row packing as VideoOverlayTrack (one shared row for
 * mutually-exclusive Full-Screen/Split-Screen overlays, one row per
 * Picture-in-Picture overlay) so a segment here always lines up with its
 * own video block directly below it.
 *
 * Each segment is filled with a gradient from neutral (the base clip's
 * "main audio" end) to that overlay's own layout color (its "overlay
 * audio" end, the same color VideoOverlayTrack's own block for it uses),
 * so red/violet/teal reads consistently as "this overlay" everywhere in
 * the timeline. The white handle's own position is the actual balance.
 */
import { useRef } from "react";
import { isExclusiveLayout, type VideoOverlayClip, type VideoOverlayLayout } from "@/lib/video/video_math";

const LAYOUT_GRADIENT_TO_CLASSNAMES: Record<VideoOverlayLayout["type"], string> = {
  "full-screen": "to-amber-500",
  "picture-in-picture": "to-violet-500",
  "split-screen": "to-teal-500",
};

function AudioBalanceSegment({
  overlay,
  audioBalance,
  videoDurationSeconds,
  onChange,
  onCommit,
}: {
  overlay: VideoOverlayClip;
  audioBalance: number;
  videoDurationSeconds: number;
  onChange: (balance: number) => void;
  onCommit: (balance: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  function computeBalance(clientX: number): number {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return audioBalance;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  }

  function handlePointerDown(e: React.PointerEvent) {
    e.preventDefault();
    onChange(computeBalance(e.clientX));
    function handleMove(ev: PointerEvent) {
      onChange(computeBalance(ev.clientX));
    }
    function handleUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommit(computeBalance(ev.clientX));
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const leftPercent = videoDurationSeconds > 0 ? (overlay.startTimeSeconds / videoDurationSeconds) * 100 : 0;
  const widthPercent =
    videoDurationSeconds > 0 ? ((overlay.endTimeSeconds - overlay.startTimeSeconds) / videoDurationSeconds) * 100 : 0;
  const label = audioBalance <= 0.1 ? "Main audio" : audioBalance >= 0.9 ? "Overlay audio" : "Mixed audio";

  return (
    <div
      ref={rootRef}
      onPointerDown={handlePointerDown}
      title={`${label} -- drag to adjust the mix`}
      className={`absolute top-0 h-3 cursor-ew-resize overflow-hidden rounded-sm bg-gradient-to-r from-neutral-600 ${LAYOUT_GRADIENT_TO_CLASSNAMES[overlay.layout.type]}`}
      style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
    >
      <div
        className="pointer-events-none absolute inset-y-0 w-1 -translate-x-1/2 bg-white"
        style={{ left: `${audioBalance * 100}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.6)" }}
      />
    </div>
  );
}

export function VideoOverlayAudioTrack({
  videoOverlays,
  videoDurationSeconds,
  onChangeAudioBalance,
  onCommitAudioBalance,
}: {
  videoOverlays: VideoOverlayClip[];
  videoDurationSeconds: number;
  onChangeAudioBalance: (overlayIndex: number, balance: number) => void;
  onCommitAudioBalance: (overlayIndex: number, balance: number) => void;
}) {
  if (videoOverlays.length === 0) return null;

  const indexed = videoOverlays.map((overlay, index) => ({ overlay, index }));
  const exclusiveIndices = indexed.filter(({ overlay }) => isExclusiveLayout(overlay.layout));
  const pipIndices = indexed.filter(({ overlay }) => overlay.layout.type === "picture-in-picture");

  return (
    <div className="flex flex-col gap-0.5">
      {exclusiveIndices.length > 0 && (
        <div className="relative h-3 w-full shrink-0">
          {exclusiveIndices.map(({ overlay, index }) => (
            <AudioBalanceSegment
              key={index}
              overlay={overlay}
              audioBalance={overlay.audioBalance}
              videoDurationSeconds={videoDurationSeconds}
              onChange={(balance) => onChangeAudioBalance(index, balance)}
              onCommit={(balance) => onCommitAudioBalance(index, balance)}
            />
          ))}
        </div>
      )}
      {pipIndices.map(({ overlay, index }) => (
        <div key={index} className="relative h-3 w-full shrink-0">
          <AudioBalanceSegment
            overlay={overlay}
            audioBalance={overlay.audioBalance}
            videoDurationSeconds={videoDurationSeconds}
            onChange={(balance) => onChangeAudioBalance(index, balance)}
            onCommit={(balance) => onCommitAudioBalance(index, balance)}
          />
        </div>
      ))}
    </div>
  );
}
