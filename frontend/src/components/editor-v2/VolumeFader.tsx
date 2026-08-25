"use client";

/**
 * A compact horizontal fader -- drag anywhere along it to set a 0..1 level,
 * with a speaker-icon badge (muted/mixed/full) fixed at its own left edge
 * so the level reads at a glance without needing to look at the handle's
 * position. Extracted out of VideoOverlayFramingDialog's own audio-balance
 * control (still used there, unchanged) so MainAudioRail/BackgroundMusicRail
 * (Playground.tsx) can reuse the exact same "regular volume button" instead
 * of a second implementation.
 */
import { useRef } from "react";
import { SpeakerMutedIcon, SpeakerMixedIcon, SpeakerFullIcon } from "@/components/icons/UIIcons";

export function VolumeFader({
  value,
  onChange,
  colorClassName,
  heightClassName = "h-4",
  showLabel = true,
}: {
  value: number;
  onChange: (level: number) => void;
  colorClassName: string;
  heightClassName?: string;
  showLabel?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  function computeLevel(clientX: number): number {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return value;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  }
  function handlePointerDown(e: React.PointerEvent) {
    onChange(computeLevel(e.clientX));
    function handleMove(ev: PointerEvent) {
      onChange(computeLevel(ev.clientX));
    }
    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const SpeakerIcon = value <= 0.1 ? SpeakerMutedIcon : value >= 0.9 ? SpeakerFullIcon : SpeakerMixedIcon;
  const label = value <= 0.1 ? "Muted" : value >= 0.9 ? "Full volume" : `${Math.round(value * 100)}% volume`;

  const bar = (
    <div
      ref={rootRef}
      onPointerDown={handlePointerDown}
      title={`${label} -- drag to adjust`}
      className={`relative ${heightClassName} w-full cursor-ew-resize overflow-hidden rounded-sm bg-gradient-to-r from-neutral-600 ${colorClassName}`}
    >
      <SpeakerIcon className="pointer-events-none absolute left-0.5 top-1/2 z-10 h-2.5 w-2.5 -translate-y-1/2 text-white drop-shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
      <div
        className="pointer-events-none absolute inset-y-0 w-1 -translate-x-1/2 bg-white"
        style={{ left: `${value * 100}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.6)" }}
      />
    </div>
  );

  // No wrapping div when there's no label underneath it -- a `heightClassName`
  // of "h-full" (every rail usage in Playground.tsx) needs to resolve
  // against the REAL parent's own definite height; an extra wrapper here
  // would only ever get an auto (content-based) height of its own, which a
  // percentage height can't resolve against, collapsing the whole control
  // to zero height. See VideoOverlayFramingDialog.tsx's own usage for why
  // showLabel still exists: that one DOES want the wrapper, with a fixed
  // heightClassName ("h-4", unaffected by this).
  if (!showLabel) return bar;

  return (
    <div>
      {bar}
      <div className="mt-0.5 text-[10px] text-muted">{label}</div>
    </div>
  );
}
