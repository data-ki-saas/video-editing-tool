"use client";

/**
 * An icon + live percentage that opens a small popup with a standard
 * vertical VolumeFader -- the level reads at a glance (same reasoning as
 * VolumeFader's own module comment) without needing a horizontal fader's
 * own dedicated strip of width. Used by VideoOverlayTrack (one badge per
 * overlay segment) and Playground's two audio rails (MainAudioTrackStrip,
 * BackgroundTrackStrip) -- for the audio rails specifically, this replaced
 * a horizontal VolumeFader pinned to a fixed-width column at the rail's own
 * left edge, which offset that rail's own timeline start from FrameStrip's
 * (both no longer share one x=0), throwing off the visual alignment between
 * the shared playhead and where each rail's content actually sits at a
 * given time. A badge takes only its own small footprint instead.
 *
 * The popup is portaled to `document.body` and positioned in fixed
 * viewport coordinates (same reasoning as ContextMenu's own positioning) --
 * this badge typically sits inside a horizontally (and, per the CSS
 * overflow spec, therefore also vertically) clipped scroll container, so an
 * ordinary absolutely-positioned child would just get clipped away instead
 * of floating above the timeline.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { VolumeFader } from "./VolumeFader";
import { SpeakerMutedIcon, SpeakerMixedIcon, SpeakerFullIcon } from "@/components/icons/UIIcons";

export function VolumeBadge({
  value,
  onChange,
  onCommit,
  colorClassName,
  className,
}: {
  value: number;
  onChange: (level: number) => void;
  onCommit: (level: number) => void;
  colorClassName: string;
  // Overrides the badge button's own classes -- defaults to this
  // component's standard inline look (VideoOverlayTrack's segment badges);
  // callers that overlay the badge on top of other content (Playground's
  // audio rails) pass their own absolute-positioning classes instead.
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Runs synchronously before paint, so the popup is never shown at a
  // wrong/unclamped position even for one frame -- same pattern as
  // ContextMenu's own positioning effect.
  useLayoutEffect(() => {
    if (!open) return;
    const buttonRect = buttonRef.current?.getBoundingClientRect();
    const popup = popupRef.current;
    if (!buttonRect || !popup) return;
    const margin = 4;
    const left = Math.max(margin, Math.min(buttonRect.left, window.innerWidth - popup.offsetWidth - margin));
    const top = Math.max(margin, buttonRect.top - popup.offsetHeight - margin);
    setPosition({ top, left });
  }, [open]);

  // Closes on a click anywhere outside the button or the (portaled) popup
  // -- same reasoning as ContextMenu's own outside-click listener.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      setOpen(false);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  const SpeakerIcon = percent <= 10 ? SpeakerMutedIcon : percent >= 90 ? SpeakerFullIcon : SpeakerMixedIcon;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((prev) => !prev)}
        title={`Volume -- ${percent}%, click to adjust`}
        className={
          className ??
          "pointer-events-auto z-10 flex shrink-0 items-center gap-0.5 rounded-sm bg-black/25 px-0.5 py-0.5 text-white hover:bg-black/50"
        }
      >
        <SpeakerIcon className="h-2.5 w-2.5" />
        <span className="text-[8px] font-medium leading-none">{percent}%</span>
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popupRef}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "fixed", top: position?.top ?? -9999, left: position?.left ?? -9999, zIndex: 60 }}
            className="rounded-md border border-border bg-surface p-2 shadow-lg"
          >
            <VolumeFader value={value} onChange={onChange} onCommit={onCommit} colorClassName={colorClassName} orientation="vertical" />
          </div>,
          document.body
        )}
    </>
  );
}
