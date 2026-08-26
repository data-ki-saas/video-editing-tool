"use client";

/**
 * A speaker icon paired with a quantified percentage and a draggable fader
 * -- horizontal (drag left/right, the default) or vertical (drag up/down,
 * top = loudest) via `orientation="vertical"`. The icon is always followed
 * by its own live percentage (0-100%) rather than a wordy "Muted"/"Full
 * volume" guess, so a level reads as an exact number everywhere it appears.
 * Extracted out of VideoOverlayFramingDialog's own audio-balance control
 * (still used there, unchanged) so MainAudioRail/BackgroundMusicRail
 * (Playground.tsx) and VideoOverlayTrack's own per-segment volume popup can
 * all reuse the same control instead of separate implementations.
 */
import { useRef } from "react";
import { SpeakerMutedIcon, SpeakerMixedIcon, SpeakerFullIcon } from "@/components/icons/UIIcons";

export function VolumeFader({
  value,
  onChange,
  onCommit,
  colorClassName,
  orientation = "horizontal",
  className,
}: {
  value: number;
  onChange: (level: number) => void;
  // Fired once on pointerup, in addition to onChange firing on every move --
  // lets a live/commit editing surface (VideoOverlayTrack's own popup) tell
  // the two apart the same way its other drag gestures already do. Omit it
  // for a plain draft-until-Save control (VideoOverlayFramingDialog) or a
  // control with no separate commit step (Playground's rail volumes).
  onCommit?: (level: number) => void;
  colorClassName: string;
  orientation?: "horizontal" | "vertical";
  // Full size classes for the draggable track itself (both axes) --
  // defaults to this component's own previous horizontal sizing, or a
  // "standard" vertical fader size, if omitted.
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const isVertical = orientation === "vertical";

  function computeLevel(clientX: number, clientY: number): number {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return value;
    if (isVertical) {
      if (rect.height <= 0) return value;
      // Top of the track reads as 100% (loudest), bottom as 0% -- standard
      // fader orientation.
      return Math.min(Math.max(1 - (clientY - rect.top) / rect.height, 0), 1);
    }
    if (rect.width <= 0) return value;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  }

  function handlePointerDown(e: React.PointerEvent) {
    onChange(computeLevel(e.clientX, e.clientY));
    function handleMove(ev: PointerEvent) {
      onChange(computeLevel(ev.clientX, ev.clientY));
    }
    function handleUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommit?.(computeLevel(ev.clientX, ev.clientY));
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  const SpeakerIcon = percent <= 10 ? SpeakerMutedIcon : percent >= 90 ? SpeakerFullIcon : SpeakerMixedIcon;

  const trackClassName = isVertical
    ? `relative cursor-ns-resize overflow-hidden rounded-sm bg-gradient-to-t from-neutral-600 ${colorClassName} ${className ?? "h-24 w-6"}`
    : `relative cursor-ew-resize overflow-hidden rounded-sm bg-gradient-to-r from-neutral-600 ${colorClassName} ${className ?? "h-4 w-full"}`;
  const fillClassName = isVertical
    ? "pointer-events-none absolute inset-x-0 h-1 -translate-y-1/2 bg-white"
    : "pointer-events-none absolute inset-y-0 w-1 -translate-x-1/2 bg-white";
  const fillStyle = isVertical
    ? { top: `${(1 - value) * 100}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.6)" }
    : { left: `${value * 100}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.6)" };

  const track = (
    <div ref={rootRef} onPointerDown={handlePointerDown} title={`${percent}% volume -- drag to adjust`} className={trackClassName}>
      {!isVertical && (
        <SpeakerIcon className="pointer-events-none absolute left-0.5 top-1/2 z-10 h-2.5 w-2.5 -translate-y-1/2 text-white drop-shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
      )}
      <div className={fillClassName} style={fillStyle} />
    </div>
  );

  if (!isVertical) {
    // The percentage sits right after the icon, both fixed at the bar's own
    // left edge (see module comment), so the pair reads together without
    // needing to look at the handle's own position.
    return (
      <div className="relative h-full">
        {track}
        <span className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-[9px] font-medium leading-none text-white drop-shadow-[0_0_1px_rgba(0,0,0,0.9)]">
          {percent}%
        </span>
      </div>
    );
  }

  // Vertical: a narrow track has no room to lay the icon and percentage out
  // side by side inside it, so that pairing sits as its own readout directly
  // above the track instead.
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-0.5 text-foreground">
        <SpeakerIcon className="h-3 w-3" />
        <span className="text-[10px] font-medium leading-none">{percent}%</span>
      </div>
      {track}
    </div>
  );
}
