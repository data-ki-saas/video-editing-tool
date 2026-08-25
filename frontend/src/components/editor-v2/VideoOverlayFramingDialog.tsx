"use client";

/**
 * Popup for fine-tuning HOW a video overlay's own footage is framed --
 * opened from the crosshair button on its VideoOverlayTrack segment. Every
 * layout that crops footage into a differently-shaped box than its own
 * source (Full-Screen, Split-Screen, a mismatched-aspect Picture-in-Picture
 * box) does so via a "cover" fit (video_math.ts's computeCoverFitSourceRect)
 * -- this is the only way to choose WHICH part of the source survives that
 * crop instead of always getting the dead-centered default, plus flip.
 *
 * Full-Screen/Picture-in-Picture show ONE pane (the overlay's own -- the
 * base clip is either fully hidden or untouched, nothing of its own to
 * frame here). Split-Screen shows BOTH panes, arranged the same way
 * they'll actually appear (side by side or top/bottom, whichever side each
 * occupies) -- each sized to its own real aspect ratio, since seeing the
 * true pane shape is what makes the useful drag direction obvious without
 * this dialog needing to guess or lock an axis. Saved together as one undo
 * step, since they're really one "how does this split look" decision.
 *
 * Flip/Mirror are visualized live (the pane's own image is mirrored, not
 * just a stored flag) -- the pan marker's on-screen position is adjusted
 * to match (so it still sits exactly on the point you'd click to land
 * there again), while the STORED panX/panY stay true source-space
 * coordinates regardless of flip.
 *
 * Keeps its own local draft state and only commits on "Save" -- same
 * pattern as TextOverlayDialog/TranscriptCaptionDialog, not a live/commit
 * split against the outer edit history.
 */
import { useEffect, useRef, useState } from "react";
import {
  computeOverlayRects,
  DEFAULT_OVERLAY_FRAMING,
  type OverlayFraming,
  type VideoOverlayClip,
} from "@/lib/video/video_math";
import { FlipHorizontalIcon, FlipVerticalIcon } from "@/components/icons/UIIcons";

function FramingPane({
  label,
  borderColorClassName,
  frameUrl,
  aspectRatio,
  framing,
  onChange,
}: {
  label: string;
  borderColorClassName: string;
  frameUrl: string;
  aspectRatio: number | null;
  framing: OverlayFraming;
  onChange: (framing: OverlayFraming) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  function updatePanFromPoint(clientX: number, clientY: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // The pane's own image is displayed mirrored when flip is on (see the
    // <img> transform below) -- mapping a click back to the TRUE
    // source-space pan means un-mirroring it here, the exact inverse of
    // how markerX/markerY (below) mirror the stored value for display.
    const rawX = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    const rawY = Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1);
    const panX = framing.flipHorizontal ? 1 - rawX : rawX;
    const panY = framing.flipVertical ? 1 - rawY : rawY;
    onChange({ ...framing, panX, panY });
  }

  function handlePointerDown(e: React.PointerEvent) {
    updatePanFromPoint(e.clientX, e.clientY);
    function handleMove(ev: PointerEvent) {
      updatePanFromPoint(ev.clientX, ev.clientY);
    }
    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const markerX = framing.flipHorizontal ? 1 - framing.panX : framing.panX;
  const markerY = framing.flipVertical ? 1 - framing.panY : framing.panY;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        className={`relative w-full cursor-crosshair select-none overflow-hidden rounded-md border-2 bg-neutral-950 ${borderColorClassName}`}
        style={{ aspectRatio: aspectRatio && aspectRatio > 0 ? `${aspectRatio}` : "16 / 9" }}
      >
        {frameUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a short-lived thumbnail data URL, not a Next-optimizable static asset
          <img
            src={frameUrl}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            style={{ transform: `scale(${framing.flipHorizontal ? -1 : 1}, ${framing.flipVertical ? -1 : 1})` }}
          />
        )}
        <div
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent/80 shadow"
          style={{ left: `${markerX * 100}%`, top: `${markerY * 100}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-[11px] font-medium text-muted">{label}</span>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => onChange({ ...framing, flipHorizontal: !framing.flipHorizontal })}
            aria-pressed={framing.flipHorizontal}
            title="Flip"
            className={
              "rounded-sm border p-1 " +
              (framing.flipHorizontal ? "border-accent bg-accent/10 text-accent" : "border-border text-foreground hover:bg-background")
            }
          >
            <FlipHorizontalIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...framing, flipVertical: !framing.flipVertical })}
            aria-pressed={framing.flipVertical}
            title="Mirror"
            className={
              "rounded-sm border p-1 " +
              (framing.flipVertical ? "border-accent bg-accent/10 text-accent" : "border-border text-foreground hover:bg-background")
            }
          >
            <FlipVerticalIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

const LAYOUT_BORDER_COLOR_CLASSNAMES = {
  "full-screen": "border-amber-500",
  "picture-in-picture": "border-violet-500",
  "split-screen": "border-teal-500",
};

export function VideoOverlayFramingDialog({
  overlay,
  baseFrameUrl,
  overlayFrameUrl,
  outputAspectRatio,
  onSave,
  onClose,
}: {
  overlay: VideoOverlayClip;
  // The base clip's own current frame (thumbnail closest to the playhead)
  // -- only shown for Split-Screen, where the base has its own pane here.
  baseFrameUrl: string;
  overlayFrameUrl: string;
  outputAspectRatio: number | null;
  onSave: (framing: OverlayFraming, baseFraming?: OverlayFraming) => void;
  onClose: () => void;
}) {
  const [framing, setFraming] = useState(overlay.framing);
  // `?? DEFAULT_OVERLAY_FRAMING`: baseFraming was added to the split-screen
  // layout after some projects already had one persisted without it -- see
  // CanvasPlayer.tsx's identical fallback for the full explanation.
  const [baseFraming, setBaseFraming] = useState(overlay.layout.type === "split-screen" ? overlay.layout.baseFraming ?? DEFAULT_OVERLAY_FRAMING : DEFAULT_OVERLAY_FRAMING);

  // Re-syncs if a different overlay's framing dialog is opened while this
  // one is already mounted (same reasoning as TextOverlayDialog's own
  // re-sync effect).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFraming(overlay.framing);
    setBaseFraming(overlay.layout.type === "split-screen" ? overlay.layout.baseFraming ?? DEFAULT_OVERLAY_FRAMING : DEFAULT_OVERLAY_FRAMING);
  }, [overlay]);

  function handleReset() {
    setFraming(DEFAULT_OVERLAY_FRAMING);
    setBaseFraming(DEFAULT_OVERLAY_FRAMING);
  }

  function handleSave() {
    onSave(framing, overlay.layout.type === "split-screen" ? baseFraming : undefined);
  }

  const isSplitScreen = overlay.layout.type === "split-screen";
  const overlayBorderColorClassName = LAYOUT_BORDER_COLOR_CLASSNAMES[overlay.layout.type];

  // Each pane's own real aspect ratio -- what makes the useful drag
  // direction on it obvious just from its shape (see this file's module
  // comment), rather than this dialog guessing/locking one.
  let basePane: { aspectRatio: number | null } | null = null;
  let overlayPaneAspectRatio: number | null = outputAspectRatio;
  if (isSplitScreen && outputAspectRatio) {
    const { baseRect, overlayRect } = computeOverlayRects(overlay.layout);
    basePane = { aspectRatio: baseRect ? (baseRect.width / baseRect.height) * outputAspectRatio : null };
    overlayPaneAspectRatio = (overlayRect.width / overlayRect.height) * outputAspectRatio;
  } else if (overlay.layout.type === "picture-in-picture" && outputAspectRatio) {
    overlayPaneAspectRatio = (overlay.layout.rect.width / overlay.layout.rect.height) * outputAspectRatio;
  }

  // Split-Screen's two panes render in the same left-to-right/top-to-bottom
  // order they'll actually appear in (partnerFirst decides which side the
  // overlay occupies) -- seeing them in their real order and real relative
  // shape is the point.
  const basePaneEl = isSplitScreen && (
    <FramingPane
      key="base"
      label="Main video"
      borderColorClassName="border-border"
      frameUrl={baseFrameUrl}
      aspectRatio={basePane?.aspectRatio ?? null}
      framing={baseFraming}
      onChange={setBaseFraming}
    />
  );
  const overlayPaneEl = (
    <FramingPane
      key="overlay"
      label="Overlay video"
      borderColorClassName={overlayBorderColorClassName}
      frameUrl={overlayFrameUrl}
      aspectRatio={overlayPaneAspectRatio}
      framing={framing}
      onChange={setFraming}
    />
  );
  const splitScreenPartnerFirst = overlay.layout.type === "split-screen" && overlay.layout.partnerFirst;
  const splitScreenIsVertical = overlay.layout.type === "split-screen" && overlay.layout.orientation === "vertical";

  return (
    <div role="dialog" aria-modal="true" aria-label="Adjust framing" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Adjust framing</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className={"mb-1.5 flex gap-3 " + (splitScreenIsVertical ? "flex-col" : "flex-col sm:flex-row")}>
          {isSplitScreen ? (splitScreenPartnerFirst ? [overlayPaneEl, basePaneEl] : [basePaneEl, overlayPaneEl]) : overlayPaneEl}
        </div>
        <p className="mb-3 text-[11px] text-muted">
          Click or drag {isSplitScreen ? "either frame" : "the frame"} to choose which part stays in view when it&apos;s cropped to fit.
        </p>

        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={handleReset} className="text-xs text-muted hover:text-foreground hover:underline">
            Reset
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-background">
              Cancel
            </button>
            <button type="button" onClick={handleSave} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground">
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
