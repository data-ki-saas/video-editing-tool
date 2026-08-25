"use client";

/**
 * Popup for fine-tuning HOW a video overlay's own footage is framed --
 * opened from the small crosshair button on its VideoOverlayTrack segment
 * (every layout shows one; Full-Screen/Split-Screen/a mismatched-aspect
 * Picture-in-Picture box all crop the overlay's footage via a "cover" fit,
 * see video_math.ts's computeCoverFitSourceRect, and this is the only way
 * to choose WHICH part of the source survives that crop instead of always
 * getting the dead-centered default).
 *
 * Shows the overlay asset's own representative still frame at its real
 * (uncropped) aspect ratio -- click or drag anywhere on it to move the
 * marker, which recenters the crop there live. Flip is separate from
 * panning (toggled with two plain buttons, not a live-mirrored preview of
 * the frame itself) since flip is applied to the FINAL cropped picture,
 * not to how the source is sampled -- mirroring it here too would make the
 * marker's own position confusing to reason about relative to what you
 * clicked.
 *
 * Keeps its own local draft state and only commits on "Save" -- same
 * pattern as TextOverlayDialog/TranscriptCaptionDialog, not a live/commit
 * split against the outer edit history.
 */
import { useEffect, useState } from "react";
import { DEFAULT_OVERLAY_FRAMING, type OverlayFraming } from "@/lib/video/video_math";
import { FlipHorizontalIcon, FlipVerticalIcon } from "@/components/icons/UIIcons";

export function VideoOverlayFramingDialog({
  previewFrameUrl,
  framing,
  onSave,
  onClose,
}: {
  previewFrameUrl: string;
  framing: OverlayFraming;
  onSave: (framing: OverlayFraming) => void;
  onClose: () => void;
}) {
  const [panX, setPanX] = useState(framing.panX);
  const [panY, setPanY] = useState(framing.panY);
  const [flipHorizontal, setFlipHorizontal] = useState(framing.flipHorizontal);
  const [flipVertical, setFlipVertical] = useState(framing.flipVertical);

  // Re-syncs if a different overlay's framing dialog is opened while this
  // one is already mounted (same reasoning as TextOverlayDialog's own
  // re-sync effect).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPanX(framing.panX);
    setPanY(framing.panY);
    setFlipHorizontal(framing.flipHorizontal);
    setFlipVertical(framing.flipVertical);
  }, [framing]);

  function updatePanFromPoint(container: HTMLElement, clientX: number, clientY: number) {
    const rect = container.getBoundingClientRect();
    setPanX(Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1));
    setPanY(Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1));
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const container = e.currentTarget;
    updatePanFromPoint(container, e.clientX, e.clientY);

    function handleMove(ev: PointerEvent) {
      updatePanFromPoint(container, ev.clientX, ev.clientY);
    }
    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  function handleReset() {
    setPanX(DEFAULT_OVERLAY_FRAMING.panX);
    setPanY(DEFAULT_OVERLAY_FRAMING.panY);
    setFlipHorizontal(DEFAULT_OVERLAY_FRAMING.flipHorizontal);
    setFlipVertical(DEFAULT_OVERLAY_FRAMING.flipVertical);
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Adjust framing" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Adjust framing</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div
          onPointerDown={handlePointerDown}
          className="relative mb-1.5 w-full cursor-crosshair select-none overflow-hidden rounded-md bg-neutral-950"
          style={{ aspectRatio: "16 / 9" }}
        >
          {previewFrameUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived thumbnail data URL, not a Next-optimizable static asset
            <img src={previewFrameUrl} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
          ) : (
            <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">No preview yet</p>
          )}
          <div
            className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent/80 shadow"
            style={{ left: `${panX * 100}%`, top: `${panY * 100}%` }}
          />
        </div>
        <p className="mb-3 text-[11px] text-muted">Click or drag to choose which part of this clip stays in view when it&apos;s cropped to fit.</p>

        <div className="mb-3 flex gap-2">
          <button
            type="button"
            onClick={() => setFlipHorizontal((v) => !v)}
            aria-pressed={flipHorizontal}
            className={
              "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-sm " +
              (flipHorizontal ? "border-accent bg-accent/10 text-accent" : "border-border text-foreground hover:bg-background")
            }
          >
            <FlipHorizontalIcon className="h-4 w-4" />
            Flip
          </button>
          <button
            type="button"
            onClick={() => setFlipVertical((v) => !v)}
            aria-pressed={flipVertical}
            className={
              "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-sm " +
              (flipVertical ? "border-accent bg-accent/10 text-accent" : "border-border text-foreground hover:bg-background")
            }
          >
            <FlipVerticalIcon className="h-4 w-4" />
            Mirror
          </button>
        </div>

        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={handleReset} className="text-xs text-muted hover:text-foreground hover:underline">
            Reset
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-background">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave({ panX, panY, flipHorizontal, flipVertical })}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
