"use client";

/**
 * One row per avatar overlay clip (see lib/video/video_math.ts's
 * AvatarOverlayClip) -- a hybrid of two existing rails' mechanics, since an
 * avatar clip is shaped like neither one alone:
 *  - Edge-drag-to-resize is TextOverlayTrack's own gesture, reused verbatim
 *    (same MIN_DURATION_SECONDS clamp, same half-open startTimeSeconds/
 *    endTimeSeconds shape) -- an avatar clip carries its own start/end,
 *    unlike TtsOverlayTrack's fixed-duration segment (a narration's length
 *    comes from its generated audio, an avatar's doesn't).
 *  - Body-drag-to-move is VideoOverlayTrack's own gesture (TextOverlayTrack
 *    has none -- a text caption is only ever resized, never slid in time
 *    without also changing its wording's own window) -- a bare press that
 *    never moves past DRAG_THRESHOLD_PX still counts as a click, not a
 *    drag, and opens AvatarFramingDialog pre-filled instead of committing a
 *    no-op position change. Same "grab middle vs. grab edge" hit-test as
 *    VideoOverlayTrack: the edge handles stopPropagation() before their own
 *    pointerdown runs, so a pointerdown reaching the segment's own root
 *    only happens when it didn't land on an edge.
 *
 * Any number of avatar overlays can be visible at once (see
 * findActiveAvatarOverlays' own doc comment in video_math.ts) -- same "one
 * row per overlay" structure as TextOverlayTrack/TtsOverlayTrack (this
 * component's own flex-col wrapper gives each overlay its own row), so
 * overlapping clips stack vertically instead of visually colliding in one
 * shared row.
 *
 * Labeled with the picked avatar's OWN name (AVATAR_LIBRARY's
 * design.meta.name, via getAvatarLibraryEntry) rather than freeform text --
 * unlike a text/TTS overlay, an avatar clip has no author-typed content of
 * its own to show here.
 */
import { useRef } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { getAvatarLibraryEntry } from "@/lib/video/avatar/library";
import type { AvatarOverlayClip } from "@/lib/video/video_math";

const MIN_DURATION_SECONDS = 0.2;
// Pixel movement, from the initial pointerdown, before a press-and-move on
// the segment body counts as a drag rather than a click -- same threshold
// VideoOverlayTrack.tsx's own startBodyDrag uses.
const DRAG_THRESHOLD_PX = 4;

function AvatarOverlaySegment({
  overlay,
  videoDurationSeconds,
  onChangeRange,
  onCommitRange,
  onChangePosition,
  onCommitPosition,
  onEdit,
  onDelete,
}: {
  overlay: AvatarOverlayClip;
  videoDurationSeconds: number;
  onChangeRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onChangePosition: (startTimeSeconds: number) => void;
  onCommitPosition: (startTimeSeconds: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();
  // Falls back to a generic label rather than throwing -- a project saved
  // against a since-removed/renamed library entry should still render a
  // (blankly-labeled) segment instead of crashing the whole timeline.
  const avatarName = getAvatarLibraryEntry(overlay.avatarId)?.design.meta.name ?? "Avatar";

  function startEdgeDrag(e: React.PointerEvent, edge: "start" | "end") {
    e.preventDefault();
    e.stopPropagation(); // load-bearing: keeps this from also triggering startBodyDrag on the root
    const track = rootRef.current?.parentElement;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const startTimeSeconds = overlay.startTimeSeconds;
    const endTimeSeconds = overlay.endTimeSeconds;

    function computeNext(clientX: number): [number, number] {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      if (edge === "start") {
        const next = Math.min(Math.max(startTimeSeconds + dxSeconds, 0), endTimeSeconds - MIN_DURATION_SECONDS);
        return [next, endTimeSeconds];
      }
      const next = Math.max(
        Math.min(endTimeSeconds + dxSeconds, videoDurationSeconds),
        startTimeSeconds + MIN_DURATION_SECONDS
      );
      return [startTimeSeconds, next];
    }

    function handleMove(moveEvent: PointerEvent) {
      onChangeRange(...computeNext(moveEvent.clientX));
    }
    function handleUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommitRange(...computeNext(upEvent.clientX));
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  function startBodyDrag(e: React.PointerEvent) {
    if (e.button !== 0) return; // right-click reaches onContextMenu instead -- same guard CutawayTrack/MarkerTrack use, so a right-click doesn't also fire this body's own click-to-edit path
    e.preventDefault();
    const track = rootRef.current?.parentElement;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const durationSeconds = overlay.endTimeSeconds - overlay.startTimeSeconds;
    const maxStart = Math.max(videoDurationSeconds - durationSeconds, 0);
    let dragged = false;

    function computeNext(clientX: number): number {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      return Math.min(Math.max(overlay.startTimeSeconds + dxSeconds, 0), maxStart);
    }
    function handleMove(ev: PointerEvent) {
      if (!dragged && Math.abs(ev.clientX - startX) >= DRAG_THRESHOLD_PX) dragged = true;
      onChangePosition(computeNext(ev.clientX));
    }
    function handleUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      // A press that never moved past the threshold is a click, not a drag
      // -- opens AvatarFramingDialog (same "click the segment to edit"
      // affordance TextOverlayTrack always offers) instead of committing a
      // no-op position change.
      if (dragged) onCommitPosition(computeNext(ev.clientX));
      else onEdit();
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const leftPercent = videoDurationSeconds > 0 ? (overlay.startTimeSeconds / videoDurationSeconds) * 100 : 0;
  const widthPercent =
    videoDurationSeconds > 0 ? ((overlay.endTimeSeconds - overlay.startTimeSeconds) / videoDurationSeconds) * 100 : 0;

  return (
    <div ref={rootRef} className="relative h-5 w-full shrink-0">
      <div
        onPointerDown={startBodyDrag}
        onContextMenu={(e) =>
          openContextMenu(e, [
            { label: "Edit avatar", onSelect: onEdit },
            { label: "Remove avatar", danger: true, onSelect: onDelete },
          ])
        }
        title={`${avatarName} -- drag to move, an edge to trim; click to edit, right-click to edit or remove`}
        className="absolute top-0 flex h-full cursor-grab items-center overflow-hidden rounded-sm border border-teal-400 bg-teal-400/20 px-1"
        style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
      >
        <span className="pointer-events-none select-none truncate text-[9px] text-teal-100">{avatarName}</span>
        <div
          onPointerDown={(e) => startEdgeDrag(e, "start")}
          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-teal-400/60"
        />
        <div
          onPointerDown={(e) => startEdgeDrag(e, "end")}
          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-teal-400/60"
        />
      </div>
      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}

export function AvatarOverlayTrack({
  avatarOverlays,
  videoDurationSeconds,
  onChangeRange,
  onCommitRange,
  onChangePosition,
  onCommitPosition,
  onEdit,
  onDelete,
}: {
  avatarOverlays: AvatarOverlayClip[];
  videoDurationSeconds: number;
  onChangeRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onChangePosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onCommitPosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onEdit: (overlayIndex: number) => void;
  onDelete: (overlayIndex: number) => void;
}) {
  if (avatarOverlays.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      {avatarOverlays.map((overlay, index) => (
        <AvatarOverlaySegment
          key={overlay.id}
          overlay={overlay}
          videoDurationSeconds={videoDurationSeconds}
          onChangeRange={(start, end) => onChangeRange(index, start, end)}
          onCommitRange={(start, end) => onCommitRange(index, start, end)}
          onChangePosition={(start) => onChangePosition(index, start)}
          onCommitPosition={(start) => onCommitPosition(index, start)}
          onEdit={() => onEdit(index)}
          onDelete={() => onDelete(index)}
        />
      ))}
    </div>
  );
}
