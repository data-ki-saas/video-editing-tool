"use client";

/**
 * Image overlay's own rail -- exact structural twin of VideoOverlayTrack.tsx
 * (see that file's own module comment for the full split-into-two-row-groups
 * rationale), minus the two things only a VIDEO overlay has: a volume
 * badge/audio-balance mix (images have no audio) and the flag-icon
 * source-start button (a still image has no playback timeline to mark an
 * in-point on). Everything else -- exclusive-vs-Picture-in-Picture packing,
 * edge-drag (trim) + body-drag (move), the `layoutGroup` prop FrameStrip.tsx
 * uses to interleave this with VideoOverlayTrack's own two row-groups into
 * one z-order-accurate stack -- is identical.
 *
 * Uses its OWN 3-hue palette (sky / fuchsia / lime) rather than video
 * overlay's amber / violet / teal, so the two overlay kinds read as visually
 * distinct families at a glance, on this rail and on the matching "Image
 * Overlay" vertical tab (UserActions.tsx).
 */
import { useRef } from "react";
import { ContextMenu, useContextMenu, type ContextMenuAction } from "./ContextMenu";
import { SplitScreenOrientationIcon, SwapIcon, FramingIcon, PictureInPictureIcon, FullScreenIcon } from "@/components/icons/UIIcons";
import {
  isExclusiveLayout,
  snapToNearest,
  MIN_VIDEO_OVERLAY_DURATION_SECONDS as MIN_DURATION_SECONDS,
  type ImageOverlayClip,
  type VideoOverlayLayout,
} from "@/lib/video/video_math";
import { getFilterPresetOption } from "@/lib/video/filterPresets";

const SNAP_THRESHOLD_PX = 8;

const LAYOUT_COLOR_CLASSNAMES: Record<VideoOverlayLayout["type"], string> = {
  "full-screen": "border-sky-700 bg-sky-500",
  "picture-in-picture": "border-fuchsia-700 bg-fuchsia-500",
  "split-screen": "border-lime-700 bg-lime-600",
};
const LAYOUT_TEXT_COLOR_CLASSNAMES: Record<VideoOverlayLayout["type"], string> = {
  "full-screen": "text-sky-600",
  "picture-in-picture": "text-fuchsia-600",
  "split-screen": "text-lime-700",
};

function ImageOverlaySegment({
  overlay,
  thumbnailUrl,
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
  onOpenFilter,
  onDelete,
}: {
  overlay: ImageOverlayClip;
  thumbnailUrl: string;
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
  onOpenFilter: () => void;
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
      onContextMenu={(e) =>
        openContextMenu(e, [...layoutMenuEntries, { label: "Filter…", onSelect: onOpenFilter }, { label: "Remove overlay", danger: true, onSelect: onDelete }])
      }
      title="Drag the middle to move, an edge to trim; right-click to change layout or remove"
      className={`absolute top-0 flex h-5 cursor-grab items-center gap-1 overflow-hidden rounded-sm border px-1 ${LAYOUT_COLOR_CLASSNAMES[overlay.layout.type]}`}
      style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
    >
      {thumbnailUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL, not a Next-optimizable static asset
        <img
          src={thumbnailUrl}
          alt=""
          className="z-10 h-3 w-3 shrink-0 rounded-sm object-cover"
          style={{ filter: getFilterPresetOption(overlay.colorFilterId ?? null).cssFilter }}
        />
      )}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onOpenFraming}
        title="Adjust framing -- recenter or flip this overlay's own photo"
        className="pointer-events-auto z-10 shrink-0 rounded-sm bg-black/25 p-0.5 text-white hover:bg-black/50"
      >
        <FramingIcon className="h-2.5 w-2.5" />
      </button>
      {overlay.colorFilterId && (
        <span
          className="pointer-events-none z-10 shrink-0 truncate rounded-full bg-black/30 px-1 text-[9px] font-normal leading-none text-white"
          title={getFilterPresetOption(overlay.colorFilterId).name}
        >
          {getFilterPresetOption(overlay.colorFilterId).name}
        </span>
      )}
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

export function ImageOverlayTrack({
  imageOverlays,
  assetUrlById,
  videoDurationSeconds,
  snapPointsSeconds,
  layoutGroup,
  onChangeRange,
  onCommitRange,
  onChangePosition,
  onCommitPosition,
  onChangeLayout,
  onToggleOrientation,
  onToggleSides,
  onOpenFraming,
  onOpenFilter,
  onDelete,
}: {
  imageOverlays: ImageOverlayClip[];
  assetUrlById: Record<string, string>;
  videoDurationSeconds: number;
  snapPointsSeconds: number[];
  // See VideoOverlayTrack.tsx's own doc comment on this prop -- identical
  // contract, just for the image-overlay array.
  layoutGroup?: "exclusive" | "picture-in-picture";
  onChangeRange: (overlayIndex: number, start: number, end: number) => void;
  onCommitRange: (overlayIndex: number, start: number, end: number) => void;
  onChangePosition: (overlayIndex: number, start: number) => void;
  onCommitPosition: (overlayIndex: number, start: number) => void;
  onChangeLayout: (overlayIndex: number, layoutType: VideoOverlayLayout["type"], splitScreenOrientation?: "horizontal" | "vertical") => void;
  onToggleOrientation: (overlayIndex: number) => void;
  onToggleSides: (overlayIndex: number) => void;
  onOpenFraming: (overlayIndex: number) => void;
  onOpenFilter: (overlayIndex: number) => void;
  onDelete: (overlayIndex: number) => void;
}) {
  if (imageOverlays.length === 0) return null;

  const indexed = imageOverlays.map((overlay, index) => ({ overlay, index }));
  const exclusiveSorted = indexed
    .filter(({ overlay }) => isExclusiveLayout(overlay.layout))
    .sort((a, b) => a.overlay.startTimeSeconds - b.overlay.startTimeSeconds);
  const pipEntries = indexed.filter(({ overlay }) => overlay.layout.type === "picture-in-picture");

  function segmentProps(index: number, prevBoundSeconds: number, nextBoundSeconds: number) {
    const overlay = imageOverlays[index];
    return {
      overlay,
      thumbnailUrl: assetUrlById[overlay.assetId] ?? "",
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
      onOpenFilter: () => onOpenFilter(index),
      onDelete: () => onDelete(index),
    };
  }

  return (
    <div className="flex flex-col gap-0.5">
      {layoutGroup !== "exclusive" &&
        pipEntries.map(({ index }) => (
          <div key={index} className="relative h-5 w-full shrink-0">
            <ImageOverlaySegment {...segmentProps(index, 0, videoDurationSeconds)} />
          </div>
        ))}
      {layoutGroup !== "picture-in-picture" && exclusiveSorted.length > 0 && (
        <div className="relative h-5 w-full shrink-0">
          {exclusiveSorted.map(({ index }, pos) => (
            <ImageOverlaySegment
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
    </div>
  );
}
