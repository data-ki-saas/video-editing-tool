"use client";

/**
 * A row of named point-markers on a timeline -- click empty space to drop
 * one (renamed inline immediately, reusing InlineEditableText exactly the
 * way ProjectList renames a reel), drag an existing one to reposition it
 * (a popup shows the frame it's about to pin to, when `frameThumbnails` is
 * supplied), right-click for "Pin"/"Unpin" or "Delete Marker" -- a pinned
 * marker (TimelineMarker.pinned) renders red instead of amber and can't be
 * dragged at all (startDrag below bails out immediately), so a planning
 * point the user has settled on can't be bumped by an accidental drag.
 * Purely a planning/organizational aid ("cut to
 * PIP here") -- never affects a frame's own content, matching this app's
 * "cosmetic, not undo-tracked" convention for that kind of state (see
 * projects.ts's TimelineMarker doc comment).
 *
 * Generic over WHOSE timeline it's placed against: the main sequence's own
 * FrameStrip mounts one at the OUTPUT-timeline scale (with
 * `snapPointsSeconds` wired to the same magnetic snap points
 * VideoOverlayTrack's drag uses, so a marker can lock onto a clip
 * boundary/effect edge/another overlay's own edge instead of needing
 * pixel-perfect placement); OverlaySourceStartDialog mounts a second one
 * at a specific asset's own SOURCE-footage scale, no snap points needed
 * there (nothing meaningful to snap to inside a single source clip's own
 * timeline yet) -- always fed exactly one marker there, representing that
 * overlay placement's own VideoOverlayClip.sourceStartSeconds rather than
 * a freeform planning point.
 */
import { useRef, useState } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { InlineEditableText } from "@/components/InlineEditableText";
import { findClosestTimestampIndex, snapToNearest } from "@/lib/video/video_math";
import type { TimelineMarker } from "@/lib/projects";

const SNAP_THRESHOLD_PX = 8;
const DRAG_START_THRESHOLD_PX = 4;
const DEFAULT_MARKER_LABEL = "Marker";

export function MarkerTrack({
  markers,
  totalDurationSeconds,
  snapPointsSeconds = [],
  frameThumbnails,
  frameThumbnailTimestampsSeconds,
  onAdd,
  onMove,
  onRename,
  onDelete,
  onTogglePin,
}: {
  markers: TimelineMarker[];
  totalDurationSeconds: number;
  snapPointsSeconds?: number[];
  // Optional per-second thumbnails of the SAME footage this track's times
  // are measured against (FrameStrip's own `thumbnails` for the main
  // sequence, or OverlaySourceStartDialog's own asset-scoped set) -- when
  // supplied, dragging a marker shows a popup of the frame it's about to
  // pin to. Omitted entirely just means no popup, not a broken one.
  frameThumbnails?: string[];
  frameThumbnailTimestampsSeconds?: number[];
  onAdd: (timeSeconds: number) => void;
  onMove: (index: number, timeSeconds: number) => void;
  onRename: (index: number, label: string) => void;
  onDelete: (index: number) => void;
  onTogglePin: (index: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (totalDurationSeconds <= 0 || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    onAdd(fraction * totalDurationSeconds);
  }

  function startDrag(e: React.PointerEvent, index: number) {
    // Only the primary (left) button drags -- a right-click fires
    // pointerdown too (button 2), excluded outright so it can't fight the
    // browser's native "contextmenu" event the delete menu below relies on.
    if (e.button !== 0) return;
    if (markers[index]?.pinned) return;
    e.stopPropagation();
    const track = trackRef.current;
    if (!track || totalDurationSeconds <= 0) return;
    const trackRect = track.getBoundingClientRect();
    const snapThresholdSeconds = (SNAP_THRESHOLD_PX / trackRect.width) * totalDurationSeconds;
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    // A touch/pen "long press" for the OS/browser's OWN context menu also
    // reports pointerdown with button 0 (touch has no separate right
    // button) -- committing to a drag immediately, the way a real mouse
    // safely can (its right-click is already excluded above), swallowed
    // that long-press gesture before the browser ever recognized it: the
    // marker just crept a few px from finger jitter during the hold,
    // "Delete Marker" never got a chance to open. A mouse has no long-press
    // path to protect, so it still starts dragging on the very first move
    // tick (threshold 0); touch/pen wait for real movement past a small
    // threshold first, so a stationary long-press never counts as a drag.
    const thresholdPx = e.pointerType === "mouse" ? 0 : DRAG_START_THRESHOLD_PX;
    let hasStartedDragging = false;

    function computeTime(clientX: number): number {
      const fraction = Math.min(Math.max((clientX - trackRect.left) / trackRect.width, 0), 1);
      const raw = fraction * totalDurationSeconds;
      return Math.min(Math.max(snapToNearest(raw, snapPointsSeconds, snapThresholdSeconds), 0), totalDurationSeconds);
    }

    function handleMove(moveEvent: PointerEvent) {
      if (!hasStartedDragging) {
        const distance = Math.hypot(moveEvent.clientX - startClientX, moveEvent.clientY - startClientY);
        if (distance < thresholdPx) return;
        hasStartedDragging = true;
        setDraggingIndex(index);
      }
      moveEvent.preventDefault();
      onMove(index, computeTime(moveEvent.clientX));
    }
    function handleUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      if (hasStartedDragging) {
        onMove(index, computeTime(upEvent.clientX));
        setDraggingIndex(null);
      }
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const toPercent = (seconds: number) => (totalDurationSeconds > 0 ? (seconds / totalDurationSeconds) * 100 : 0);

  const draggingMarker = draggingIndex !== null ? markers[draggingIndex] : undefined;
  const dragPreviewSrc =
    draggingMarker && frameThumbnails && frameThumbnails.length > 0 && frameThumbnailTimestampsSeconds
      ? frameThumbnails[findClosestTimestampIndex(frameThumbnailTimestampsSeconds, draggingMarker.timeSeconds)]
      : undefined;

  return (
    <div
      ref={trackRef}
      onClick={handleClick}
      title="Click to drop a marker; drag one to move it, right-click to pin or delete"
      className="relative h-5 w-full shrink-0 cursor-pointer rounded-sm bg-neutral-800"
    >
      {markers.map((marker, index) => (
        <div
          key={index}
          onPointerDown={(e) => startDrag(e, index)}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.stopPropagation();
            openContextMenu(e, [
              { label: marker.pinned ? "Unpin" : "Pin", onSelect: () => onTogglePin(index) },
              { label: "Delete Marker", danger: true, onSelect: () => onDelete(index) },
            ]);
          }}
          title={marker.pinned ? "Pinned -- right-click to unpin" : undefined}
          className={`absolute top-0 flex h-full -translate-x-1/2 items-center gap-1 ${marker.pinned ? "cursor-default" : "cursor-ew-resize"}`}
          style={{ left: `${toPercent(marker.timeSeconds)}%` }}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full border ${marker.pinned ? "border-red-900 bg-red-500" : "border-amber-900 bg-amber-400"}`} />
          <span className={`whitespace-nowrap rounded-sm bg-black/70 px-1 text-[10px] leading-none ${marker.pinned ? "text-red-400" : "text-amber-300"}`}>
            {marker.timeSeconds.toFixed(1)}s
          </span>
          <InlineEditableText
            value={marker.label}
            onCommit={(label) => onRename(index, label)}
            ariaLabel="Marker label"
            className="whitespace-nowrap rounded-sm bg-black/70 px-1 text-[10px] leading-none text-white"
            inputClassName="whitespace-nowrap rounded-sm border border-accent bg-black/90 px-1 text-[10px] leading-none text-white outline-none"
          />
          {draggingIndex === index && dragPreviewSrc && (
            <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 rounded-md border border-border bg-neutral-900 p-1 shadow-lg">
              {/* eslint-disable-next-line @next/next/no-img-element -- short-lived data URL, not a Next-optimizable remote image */}
              <img src={dragPreviewSrc} alt="" className="h-16 w-auto rounded-sm object-cover" />
              <div className="mt-0.5 text-center text-[10px] leading-none text-white">
                {marker.timeSeconds.toFixed(1)}s
              </div>
            </div>
          )}
        </div>
      ))}
      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}

export { DEFAULT_MARKER_LABEL };
