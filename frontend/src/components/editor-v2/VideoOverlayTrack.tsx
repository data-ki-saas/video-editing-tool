"use client";

/**
 * One rail for every VideoOverlayClip (see lib/video/video_math.ts), split
 * into two internal packing strategies since the array holds two kinds of
 * clip at once:
 *  - EXCLUSIVE-layout clips (Full-Screen, Split Screen) share ONE row,
 *    sorted by time, neighbor-clamped -- same "mutually exclusive, packed
 *    row" structure as ZoomEffectsTrack.tsx, since these can never overlap.
 *  - Picture-in-Picture clips each get their OWN row -- same "one row per
 *    clip" structure as OverlayTrack.tsx, since these can legitimately
 *    overlap each other (and sit alongside/underneath the exclusive row).
 *
 * A clip switches between the two groups in place (via this component's own
 * right-click menu, isExclusiveLayout deciding which visual row it belongs
 * in) without losing its position, duration, or source asset -- the whole
 * point of unifying Full-Screen/Picture-in-Picture/Split Screen under one
 * VideoOverlayClip type with a switchable `layout` instead of three
 * separate always-placed-fresh types.
 *
 * Each segment supports both edge-drag (trim, existing pattern) AND
 * body-drag (move the whole block without changing duration -- a real gap
 * neither OverlayTrack nor ZoomEffectsTrack close today). The "grab middle
 * vs. grab edge" hit-test is pure DOM event order: the edge handles call
 * stopPropagation() before their own pointerdown handler runs, so a
 * pointerdown that reaches the segment's own root only happens when it
 * didn't land on an edge.
 */
import { useRef } from "react";
import { ContextMenu, useContextMenu, type ContextMenuAction } from "./ContextMenu";
import {
  SplitScreenOrientationIcon,
  SwapIcon,
  FramingIcon,
  MarkerFlagIcon,
  PictureInPictureIcon,
  FullScreenIcon,
} from "@/components/icons/UIIcons";
import { isExclusiveLayout, snapToNearest, type VideoOverlayClip, type VideoOverlayLayout } from "@/lib/video/video_math";

const MIN_DURATION_SECONDS = 0.2;

// Pixel distance (converted to seconds via the drag's own trackRect) within
// which a drag magnetically snaps to a nearby time reference -- a
// reasonable magnetic-snap distance, not so large it fights normal
// fine-grained dragging.
const SNAP_THRESHOLD_PX = 8;

// Matches each rail color used below -- also used to tint the matching
// entry's label in the right-click menu (Switch to X), so the menu reads
// as "which color am I about to turn this into" rather than plain text.
const LAYOUT_COLOR_CLASSNAMES: Record<VideoOverlayLayout["type"], string> = {
  "full-screen": "border-amber-700 bg-amber-500",
  "picture-in-picture": "border-violet-700 bg-violet-500",
  "split-screen": "border-teal-700 bg-teal-500",
};
const LAYOUT_TEXT_COLOR_CLASSNAMES: Record<VideoOverlayLayout["type"], string> = {
  "full-screen": "text-amber-600",
  "picture-in-picture": "text-violet-600",
  "split-screen": "text-teal-600",
};

function VideoOverlaySegment({
  overlay,
  thumbnailUrl,
  sourceDurationSeconds,
  videoDurationSeconds,
  prevBoundSeconds,
  nextBoundSeconds,
  snapPointsSeconds,
  onChangeRange,
  onCommitRange,
  onChangePosition,
  onCommitPosition,
  onChangeLayout,
  onToggleOrientation,
  onToggleSides,
  onOpenFraming,
  onOpenAssetMarkers,
  onDelete,
}: {
  overlay: VideoOverlayClip;
  thumbnailUrl: string;
  sourceDurationSeconds: number; // Infinity if not yet probed -- degrades to only the neighbor/sequence clamps until it resolves
  videoDurationSeconds: number;
  prevBoundSeconds: number; // 0 if this is the first exclusive clip (or always 0 for a PIP clip, which has no neighbor)
  nextBoundSeconds: number; // videoDurationSeconds if this is the last exclusive clip (or always videoDurationSeconds for a PIP clip)
  snapPointsSeconds: number[];
  onChangeRange: (start: number, end: number) => void;
  onCommitRange: (start: number, end: number) => void;
  onChangePosition: (start: number) => void;
  onCommitPosition: (start: number) => void;
  onChangeLayout: (layoutType: VideoOverlayLayout["type"], splitScreenOrientation?: "horizontal" | "vertical") => void;
  onToggleOrientation: () => void;
  onToggleSides: () => void;
  onOpenFraming: () => void;
  onOpenAssetMarkers: () => void;
  onDelete: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

  function startEdgeDrag(e: React.PointerEvent, edge: "start" | "end") {
    e.preventDefault();
    e.stopPropagation(); // load-bearing: keeps this from also triggering startBodyDrag on the root
    const track = rootRef.current?.parentElement;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const { startTimeSeconds, endTimeSeconds } = overlay;
    const snapThresholdSeconds = (SNAP_THRESHOLD_PX / trackRect.width) * videoDurationSeconds;

    function computeNext(clientX: number): [number, number] {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      if (edge === "start") {
        const clamped = Math.min(Math.max(startTimeSeconds + dxSeconds, prevBoundSeconds, 0), endTimeSeconds - MIN_DURATION_SECONDS);
        const snapped = snapToNearest(clamped, snapPointsSeconds, snapThresholdSeconds);
        const next = Math.min(Math.max(snapped, prevBoundSeconds, 0), endTimeSeconds - MIN_DURATION_SECONDS);
        return [next, endTimeSeconds];
      }
      // No cap at the source's own duration -- stretching the window past
      // one play-through loops the source to fill it (see CanvasPlayer.tsx
      // and compileCreatomateTimeline.ts), same convention this app's
      // background-music tracks already use. Only bounded by a neighboring
      // exclusive overlay and the sequence's own end.
      const maxEnd = Math.min(nextBoundSeconds, videoDurationSeconds);
      const clamped = Math.max(Math.min(endTimeSeconds + dxSeconds, maxEnd), startTimeSeconds + MIN_DURATION_SECONDS);
      const snapped = snapToNearest(clamped, snapPointsSeconds, snapThresholdSeconds);
      const next = Math.max(Math.min(snapped, maxEnd), startTimeSeconds + MIN_DURATION_SECONDS);
      return [startTimeSeconds, next];
    }

    function handleMove(ev: PointerEvent) {
      onChangeRange(...computeNext(ev.clientX));
    }
    function handleUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommitRange(...computeNext(ev.clientX));
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  function startBodyDrag(e: React.PointerEvent) {
    e.preventDefault();
    const track = rootRef.current?.parentElement;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const durationSeconds = overlay.endTimeSeconds - overlay.startTimeSeconds;
    const minStart = prevBoundSeconds;
    const maxStart = Math.min(nextBoundSeconds, videoDurationSeconds) - durationSeconds;
    const snapThresholdSeconds = (SNAP_THRESHOLD_PX / trackRect.width) * videoDurationSeconds;

    function computeNext(clientX: number): number {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      const clamped = Math.min(Math.max(overlay.startTimeSeconds + dxSeconds, minStart), Math.max(maxStart, minStart));
      const snapped = snapToNearest(clamped, snapPointsSeconds, snapThresholdSeconds);
      return Math.min(Math.max(snapped, minStart), Math.max(maxStart, minStart));
    }
    function handleMove(ev: PointerEvent) {
      onChangePosition(computeNext(ev.clientX));
    }
    function handleUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommitPosition(computeNext(ev.clientX));
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const leftPercent = videoDurationSeconds > 0 ? (overlay.startTimeSeconds / videoDurationSeconds) * 100 : 0;
  const durationSeconds = overlay.endTimeSeconds - overlay.startTimeSeconds;
  const widthPercent = videoDurationSeconds > 0 ? (durationSeconds / videoDurationSeconds) * 100 : 0;

  // The source's own real duration is known and shorter than the current
  // window -- i.e. this overlay is stretched past one play-through and
  // will loop. Shown as a visibly dimmed region for "this part is a
  // repeat" (much harder to miss than a bare line), with a crisp tick at
  // every repeat boundary inside it. Nothing rendered at all once the
  // window fits within a single play-through, or before the source's own
  // duration has been probed.
  const hasKnownSourceDuration = Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0;
  const repeatsWithinWindow = hasKnownSourceDuration && sourceDurationSeconds < durationSeconds;
  const repeatRegionPercent = repeatsWithinWindow ? ((durationSeconds - sourceDurationSeconds) / durationSeconds) * 100 : 0;
  const loopTickPercents: number[] = [];
  if (repeatsWithinWindow) {
    for (let boundary = sourceDurationSeconds; boundary < durationSeconds; boundary += sourceDurationSeconds) {
      loopTickPercents.push((boundary / durationSeconds) * 100);
    }
  }

  const layoutMenuEntries: ContextMenuAction[] = [];
  if (overlay.layout.type !== "full-screen") {
    layoutMenuEntries.push({
      label: "Switch to Full-Screen",
      textColorClassName: LAYOUT_TEXT_COLOR_CLASSNAMES["full-screen"],
      onSelect: () => onChangeLayout("full-screen"),
    });
  }
  if (overlay.layout.type !== "picture-in-picture") {
    layoutMenuEntries.push({
      label: "Switch to Picture-in-Picture",
      textColorClassName: LAYOUT_TEXT_COLOR_CLASSNAMES["picture-in-picture"],
      onSelect: () => onChangeLayout("picture-in-picture"),
    });
  }
  // A plain `layout.type === "split-screen"` boolean stored separately
  // doesn't let TS narrow `layout.orientation` back through it later --
  // capturing the orientation itself (null when not split-screen) sidesteps
  // that instead of re-checking the discriminant inline every time.
  const currentSplitScreenOrientation = overlay.layout.type === "split-screen" ? overlay.layout.orientation : null;
  if (currentSplitScreenOrientation !== "horizontal") {
    layoutMenuEntries.push({
      label: "Switch to Split Screen — Side by Side",
      textColorClassName: LAYOUT_TEXT_COLOR_CLASSNAMES["split-screen"],
      onSelect: () => onChangeLayout("split-screen", "horizontal"),
    });
  }
  if (currentSplitScreenOrientation !== "vertical") {
    layoutMenuEntries.push({
      label: "Switch to Split Screen — Top & Bottom",
      textColorClassName: LAYOUT_TEXT_COLOR_CLASSNAMES["split-screen"],
      onSelect: () => onChangeLayout("split-screen", "vertical"),
    });
  }

  return (
    <div
      ref={rootRef}
      onPointerDown={startBodyDrag}
      onContextMenu={(e) => openContextMenu(e, [...layoutMenuEntries, { label: "Remove overlay", danger: true, onSelect: onDelete }])}
      title="Drag the middle to move, an edge to trim; right-click to change layout or remove"
      className={`absolute top-0 flex h-5 cursor-grab items-center gap-1 overflow-hidden rounded-sm border px-1 ${LAYOUT_COLOR_CLASSNAMES[overlay.layout.type]}`}
      style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
    >
      {thumbnailUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- reuses AssetGallery's own extracted video-tile thumbnail, not a Next-optimizable static asset
        <img src={thumbnailUrl} alt="" className="z-10 h-3 w-3 shrink-0 rounded-sm object-cover" />
      )}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onOpenFraming}
        title="Adjust framing -- recenter or flip this overlay's own footage"
        className="pointer-events-auto z-10 shrink-0 rounded-sm bg-black/25 p-0.5 text-white hover:bg-black/50"
      >
        <FramingIcon className="h-2.5 w-2.5" />
      </button>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onOpenAssetMarkers}
        title="Markers -- name moments in this clip's own footage"
        className="pointer-events-auto z-10 shrink-0 rounded-sm bg-black/25 p-0.5 text-white hover:bg-black/50"
      >
        <MarkerFlagIcon className="h-2.5 w-2.5" />
      </button>
      {repeatsWithinWindow && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/35"
          style={{ width: `${repeatRegionPercent}%` }}
          title={`Repeats every ${sourceDurationSeconds.toFixed(1)}s`}
        />
      )}
      {loopTickPercents.map((percent, tickIndex) => (
        <div
          key={tickIndex}
          title="Repeats here"
          className="pointer-events-none absolute inset-y-0 w-[2px] bg-white"
          style={{ left: `${percent}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.55)" }}
        />
      ))}
      <div
        onPointerDown={(e) => startEdgeDrag(e, "start")}
        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-black/20"
      />
      <div
        onPointerDown={(e) => startEdgeDrag(e, "end")}
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-black/20"
      />
      {overlay.layout.type === "full-screen" && (
        <span
          title="Full-Screen"
          className="pointer-events-none absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded-sm bg-black/30 p-0.5 text-white"
        >
          <FullScreenIcon className="h-2.5 w-2.5" />
        </span>
      )}
      {overlay.layout.type === "picture-in-picture" && (
        <span
          title="Picture-in-Picture"
          className="pointer-events-none absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded-sm bg-black/30 p-0.5 text-white"
        >
          <PictureInPictureIcon className="h-2.5 w-2.5" />
        </span>
      )}
      {overlay.layout.type === "split-screen" && (
        <div className="pointer-events-auto absolute right-1.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5">
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onToggleOrientation}
            title="Switch side-by-side / top-and-bottom"
            className="rounded-sm bg-black/30 p-0.5 text-white hover:bg-black/50"
          >
            <SplitScreenOrientationIcon
              className="h-2.5 w-2.5"
              style={overlay.layout.orientation === "vertical" ? { transform: "rotate(90deg)" } : undefined}
            />
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onToggleSides}
            title="Swap which half this overlay occupies"
            className="rounded-sm bg-black/30 p-0.5 text-white hover:bg-black/50"
          >
            <SwapIcon className="h-2.5 w-2.5" />
          </button>
        </div>
      )}
      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}

export function VideoOverlayTrack({
  videoOverlays,
  assetThumbnailUrlById,
  overlaySourceDurationSeconds,
  videoDurationSeconds,
  snapPointsSeconds,
  onChangeRange,
  onCommitRange,
  onChangePosition,
  onCommitPosition,
  onChangeLayout,
  onToggleOrientation,
  onToggleSides,
  onOpenFraming,
  onOpenAssetMarkers,
  onDelete,
}: {
  videoOverlays: VideoOverlayClip[];
  assetThumbnailUrlById: Record<string, string>;
  overlaySourceDurationSeconds: Record<string, number>;
  videoDurationSeconds: number;
  snapPointsSeconds: number[];
  onChangeRange: (overlayIndex: number, start: number, end: number) => void;
  onCommitRange: (overlayIndex: number, start: number, end: number) => void;
  onChangePosition: (overlayIndex: number, start: number) => void;
  onCommitPosition: (overlayIndex: number, start: number) => void;
  onChangeLayout: (overlayIndex: number, layoutType: VideoOverlayLayout["type"], splitScreenOrientation?: "horizontal" | "vertical") => void;
  onToggleOrientation: (overlayIndex: number) => void;
  onToggleSides: (overlayIndex: number) => void;
  onOpenFraming: (overlayIndex: number) => void;
  onOpenAssetMarkers: (assetId: string) => void;
  onDelete: (overlayIndex: number) => void;
}) {
  if (videoOverlays.length === 0) return null;

  const indexed = videoOverlays.map((overlay, index) => ({ overlay, index }));
  const exclusiveSorted = indexed
    .filter(({ overlay }) => isExclusiveLayout(overlay.layout))
    .sort((a, b) => a.overlay.startTimeSeconds - b.overlay.startTimeSeconds);
  const pipEntries = indexed.filter(({ overlay }) => overlay.layout.type === "picture-in-picture");

  function segmentProps(index: number, prevBoundSeconds: number, nextBoundSeconds: number) {
    const overlay = videoOverlays[index];
    return {
      overlay,
      thumbnailUrl: assetThumbnailUrlById[overlay.assetId] ?? "",
      sourceDurationSeconds: overlaySourceDurationSeconds[overlay.assetId] ?? Infinity,
      videoDurationSeconds,
      prevBoundSeconds,
      nextBoundSeconds,
      snapPointsSeconds,
      onChangeRange: (start: number, end: number) => onChangeRange(index, start, end),
      onCommitRange: (start: number, end: number) => onCommitRange(index, start, end),
      onChangePosition: (start: number) => onChangePosition(index, start),
      onCommitPosition: (start: number) => onCommitPosition(index, start),
      onChangeLayout: (layoutType: VideoOverlayLayout["type"], splitScreenOrientation?: "horizontal" | "vertical") =>
        onChangeLayout(index, layoutType, splitScreenOrientation),
      onToggleOrientation: () => onToggleOrientation(index),
      onToggleSides: () => onToggleSides(index),
      onOpenFraming: () => onOpenFraming(index),
      onOpenAssetMarkers: () => onOpenAssetMarkers(overlay.assetId),
      onDelete: () => onDelete(index),
    };
  }

  return (
    <div className="flex flex-col gap-0.5">
      {exclusiveSorted.length > 0 && (
        <div className="relative h-5 w-full shrink-0">
          {exclusiveSorted.map(({ index }, pos) => (
            <VideoOverlaySegment
              key={index}
              {...segmentProps(
                index,
                pos > 0 ? exclusiveSorted[pos - 1].overlay.endTimeSeconds : 0,
                pos < exclusiveSorted.length - 1 ? exclusiveSorted[pos + 1].overlay.startTimeSeconds : videoDurationSeconds
              )}
            />
          ))}
        </div>
      )}
      {pipEntries.map(({ index }) => (
        <div key={index} className="relative h-5 w-full shrink-0">
          <VideoOverlaySegment {...segmentProps(index, 0, videoDurationSeconds)} />
        </div>
      ))}
    </div>
  );
}
