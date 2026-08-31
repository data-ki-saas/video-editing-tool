"use client";

/**
 * Popup for fine-tuning an image overlay -- exact structural twin of
 * VideoOverlayFramingDialog.tsx (see that file's own module comment for the
 * full rationale on the real-final-frame preview, the cover-fit framing
 * math, and the draft-until-Save convention), minus the one thing only a
 * VIDEO overlay has: the Sound/VolumeFader section and its `audioBalance`
 * plumbing (a still image has no audio to mix). Everything else -- Split
 * Screen's two-half preview + divider, Picture-in-Picture's moveable/
 * resizable box, Full-Screen's single pannable frame, Flip/Mirror, the Zoom
 * slider -- is identical, just reading from an ImageOverlayClip instead of
 * a VideoOverlayClip. `overlayFrameUrl` is simply the photo's own asset URL
 * here (no probed video frame needed, images are already static).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  computeCoverFitSourceRect,
  DEFAULT_OVERLAY_FRAMING,
  DEFAULT_SPLIT_SCREEN_RATIO,
  MIN_PICTURE_IN_PICTURE_ZOOM,
  type CropRect,
  type ImageOverlayClip,
  type OverlayFraming,
} from "@/lib/video/video_math";
import { FlipHorizontalIcon, FlipVerticalIcon } from "@/components/icons/UIIcons";

// Keeps either half from being dragged down to a sliver too thin to grab
// or usefully see.
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;

// Default position/size a freshly-switched Picture-in-Picture box starts
// with -- same "modest, clearly-adjustable" sizing as the image overlay
// system's own DEFAULT_OVERLAY_RECT (transformations.ts), reused here as
// the draft fallback before a real one is ever read off the overlay.
const DEFAULT_PIP_RECT: CropRect = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };

/** Converts an on-screen drag delta (already flip-corrected by the caller)
 * into the resulting panX/panY -- identical to
 * VideoOverlayFramingDialog.tsx's own computeCoverPanDelta. */
function computeCoverPanDelta(
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number,
  panX: number,
  panY: number,
  zoom: number,
  dxPx: number,
  dyPx: number,
  minZoom: number = 1
): { panX: number; panY: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return {
      panX: Math.min(Math.max(panX - dxPx / Math.max(boxWidth, 1), 0), 1),
      panY: Math.min(Math.max(panY - dyPx / Math.max(boxHeight, 1), 0), 1),
    };
  }
  const { sx, sy, sWidth, sHeight } = computeCoverFitSourceRect(naturalWidth, naturalHeight, boxWidth, boxHeight, panX, panY, zoom, minZoom);
  const denomX = naturalWidth - sWidth;
  const denomY = naturalHeight - sHeight;
  const nextSx = sx - dxPx * (sWidth / boxWidth);
  const nextSy = sy - dyPx * (sHeight / boxHeight);
  return {
    panX: denomX > 0 ? Math.min(Math.max(nextSx / denomX, 0), 1) : panX,
    panY: denomY > 0 ? Math.min(Math.max(nextSy / denomY, 0), 1) : panY,
  };
}

/** One pannable region of the final-frame preview -- identical to
 * VideoOverlayFramingDialog.tsx's own CoverFramingRegion. */
function CoverFramingRegion({
  styleRect,
  frameUrl,
  framing,
  onChange,
  onSelect,
  highlighted,
  borderColorClassName,
  label,
  minZoom = 1,
}: {
  styleRect: CSSProperties;
  frameUrl: string;
  framing: OverlayFraming;
  onChange: (framing: OverlayFraming) => void;
  onSelect?: () => void;
  highlighted: boolean;
  borderColorClassName: string;
  label: string;
  // See computeCoverFitSourceRect's own doc comment -- only ever below 1
  // for a Picture-in-Picture box, whose own render path (CanvasPlayer.tsx/
  // exportTimeline.ts) allows the matching MIN_PICTURE_IN_PICTURE_ZOOM.
  minZoom?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  function handlePointerDown(e: React.PointerEvent) {
    onSelect?.();
    const measuredRect = containerRef.current?.getBoundingClientRect();
    if (!measuredRect) return;
    const rect: DOMRect = measuredRect;
    const startX = e.clientX;
    const startY = e.clientY;
    const startFraming = framing;
    const naturalWidth = imgRef.current?.naturalWidth ?? 0;
    const naturalHeight = imgRef.current?.naturalHeight ?? 0;

    function computeNext(clientX: number, clientY: number): OverlayFraming {
      const dx = clientX - startX;
      const dy = clientY - startY;
      const effectiveDx = startFraming.flipHorizontal ? -dx : dx;
      const effectiveDy = startFraming.flipVertical ? -dy : dy;
      const next = computeCoverPanDelta(
        naturalWidth, naturalHeight, rect.width, rect.height, startFraming.panX, startFraming.panY, startFraming.zoom, effectiveDx, effectiveDy, minZoom
      );
      return { ...startFraming, ...next };
    }
    function handleMove(ev: PointerEvent) {
      onChange(computeNext(ev.clientX, ev.clientY));
    }
    function handleUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onChange(computeNext(ev.clientX, ev.clientY));
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      title={`${label} -- drag to reposition`}
      className={`absolute cursor-move overflow-hidden border-2 ${highlighted ? borderColorClassName : "border-transparent"}`}
      style={styleRect}
    >
      {frameUrl && (
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{ transform: `scale(${framing.zoom})`, transformOrigin: `${framing.panX * 100}% ${framing.panY * 100}%` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL / thumbnail data URL, not a Next-optimizable static asset */}
          <img
            ref={imgRef}
            src={frameUrl}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
            style={{
              objectPosition: `${framing.panX * 100}% ${framing.panY * 100}%`,
              transform: `scale(${framing.flipHorizontal ? -1 : 1}, ${framing.flipVertical ? -1 : 1})`,
            }}
          />
        </div>
      )}
    </div>
  );
}

/** The draggable boundary between Split Screen's two halves -- identical to
 * VideoOverlayFramingDialog.tsx's own SplitScreenDivider. */
function SplitScreenDivider({
  orientation,
  ratio,
  onChange,
}: {
  orientation: "horizontal" | "vertical";
  ratio: number;
  onChange: (ratio: number) => void;
}) {
  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const container = e.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    function computeRatio(clientX: number, clientY: number): number {
      const fraction = orientation === "horizontal" ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height;
      return Math.min(Math.max(fraction, MIN_SPLIT_RATIO), MAX_SPLIT_RATIO);
    }
    onChange(computeRatio(e.clientX, e.clientY));
    function handleMove(ev: PointerEvent) {
      onChange(computeRatio(ev.clientX, ev.clientY));
    }
    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const isHorizontal = orientation === "horizontal";
  return (
    <div
      onPointerDown={handlePointerDown}
      title="Drag to change how much space each side gets"
      className={
        "absolute z-10 flex items-center justify-center bg-white/90 shadow " +
        (isHorizontal ? "top-0 h-full w-2 -translate-x-1/2 cursor-col-resize" : "left-0 h-2 w-full -translate-y-1/2 cursor-row-resize")
      }
      style={isHorizontal ? { left: `${ratio * 100}%` } : { top: `${ratio * 100}%` }}
    >
      <div className={"rounded-full bg-neutral-500 " + (isHorizontal ? "h-6 w-0.5" : "h-0.5 w-6")} />
    </div>
  );
}

const PIP_MOVE_RIM_PX = 10;
const PIP_MIN_SIZE_FRACTION = 0.08;

/** The Picture-in-Picture box itself -- identical to
 * VideoOverlayFramingDialog.tsx's own PipFrame. */
function PipFrame({
  rect,
  onChange,
  borderColorClassName,
  children,
}: {
  rect: CropRect;
  onChange: (next: CropRect) => void;
  borderColorClassName: string;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  function startDrag(e: React.PointerEvent, mode: "move" | "resize") {
    e.preventDefault();
    e.stopPropagation();
    const measuredRect = containerRef.current?.getBoundingClientRect();
    if (!measuredRect) return;
    const containerRect: DOMRect = measuredRect;
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = rect;

    function computeNext(clientX: number, clientY: number): CropRect {
      const dxFraction = (clientX - startX) / containerRect.width;
      const dyFraction = (clientY - startY) / containerRect.height;
      if (mode === "move") {
        return {
          ...startRect,
          x: Math.min(Math.max(startRect.x + dxFraction, 0), 1 - startRect.width),
          y: Math.min(Math.max(startRect.y + dyFraction, 0), 1 - startRect.height),
        };
      }
      const width = Math.min(Math.max(startRect.width + dxFraction, PIP_MIN_SIZE_FRACTION), 1 - startRect.x);
      const height = Math.min(Math.max(startRect.height + dyFraction, PIP_MIN_SIZE_FRACTION), 1 - startRect.y);
      return { ...startRect, width, height };
    }
    function handleMove(ev: PointerEvent) {
      onChange(computeNext(ev.clientX, ev.clientY));
    }
    function handleUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onChange(computeNext(ev.clientX, ev.clientY));
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0">
      <div
        className={`absolute border-2 ${borderColorClassName}`}
        style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
      >
        <div
          onPointerDown={(e) => startDrag(e, "move")}
          title="Drag to move"
          className="pointer-events-auto absolute cursor-move"
          style={{ inset: `-${PIP_MOVE_RIM_PX}px` }}
        />
        <div className="absolute inset-0 overflow-hidden">{children}</div>
        <div
          onPointerDown={(e) => startDrag(e, "resize")}
          title="Drag to resize"
          className="pointer-events-auto absolute -bottom-1.5 -right-1.5 z-10 h-3 w-3 cursor-nwse-resize rounded-full border border-white bg-fuchsia-400"
        />
      </div>
    </div>
  );
}

// This dialog's own palette -- same sky/fuchsia/lime family as
// ImageOverlayTrack.tsx's LAYOUT_COLOR_CLASSNAMES, so the rail segment and
// this popup's highlight border always read as the same overlay.
const LAYOUT_BORDER_COLOR_CLASSNAMES = {
  "full-screen": "border-sky-500",
  "picture-in-picture": "border-fuchsia-500",
  "split-screen": "border-lime-500",
};

type SelectedSide = "base" | "overlay";

export function ImageOverlayFramingDialog({
  overlay,
  baseFrameUrl,
  overlayFrameUrl,
  outputAspectRatio,
  onSave,
  onClose,
  onDelete,
}: {
  overlay: ImageOverlayClip;
  // The base clip's own current frame (thumbnail closest to the playhead)
  // -- shown for Split Screen (its own half) and Picture-in-Picture (the
  // backdrop the PIP box sits on).
  baseFrameUrl: string;
  // The overlay photo's own asset URL -- no probing needed, unlike a video
  // overlay's captured source frame.
  overlayFrameUrl: string;
  outputAspectRatio: number | null;
  onSave: (framing: OverlayFraming, options?: { baseFraming?: OverlayFraming; ratio?: number; rect?: CropRect }) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const isSplitScreen = overlay.layout.type === "split-screen";
  const isPictureInPicture = overlay.layout.type === "picture-in-picture";

  const [framing, setFraming] = useState(overlay.framing);
  const [baseFraming, setBaseFraming] = useState(
    overlay.layout.type === "split-screen" ? overlay.layout.baseFraming ?? DEFAULT_OVERLAY_FRAMING : DEFAULT_OVERLAY_FRAMING
  );
  const [ratio, setRatio] = useState(
    overlay.layout.type === "split-screen" ? overlay.layout.ratio ?? DEFAULT_SPLIT_SCREEN_RATIO : DEFAULT_SPLIT_SCREEN_RATIO
  );
  const [pipRect, setPipRect] = useState(overlay.layout.type === "picture-in-picture" ? overlay.layout.rect : DEFAULT_PIP_RECT);
  const [selectedSide, setSelectedSide] = useState<SelectedSide>("overlay");

  // Re-syncs if a different overlay's framing dialog is opened while this
  // one is already mounted (same reasoning as TextOverlayDialog's own
  // re-sync effect).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFraming(overlay.framing);
    setBaseFraming(overlay.layout.type === "split-screen" ? overlay.layout.baseFraming ?? DEFAULT_OVERLAY_FRAMING : DEFAULT_OVERLAY_FRAMING);
    setRatio(overlay.layout.type === "split-screen" ? overlay.layout.ratio ?? DEFAULT_SPLIT_SCREEN_RATIO : DEFAULT_SPLIT_SCREEN_RATIO);
    setPipRect(overlay.layout.type === "picture-in-picture" ? overlay.layout.rect : DEFAULT_PIP_RECT);
    setSelectedSide("overlay");
  }, [overlay]);

  function handleReset() {
    setFraming(DEFAULT_OVERLAY_FRAMING);
    setBaseFraming(DEFAULT_OVERLAY_FRAMING);
    setRatio(DEFAULT_SPLIT_SCREEN_RATIO);
  }

  function handleSave() {
    onSave(framing, {
      baseFraming: isSplitScreen ? baseFraming : undefined,
      ratio: isSplitScreen ? ratio : undefined,
      rect: isPictureInPicture ? pipRect : undefined,
    });
  }

  const overlayBorderColorClassName = LAYOUT_BORDER_COLOR_CLASSNAMES[overlay.layout.type];
  const activeSide: SelectedSide = isSplitScreen ? selectedSide : "overlay";
  const activeFraming = activeSide === "base" ? baseFraming : framing;
  const setActiveFraming = activeSide === "base" ? setBaseFraming : setFraming;

  const splitScreenPartnerFirst = overlay.layout.type === "split-screen" && overlay.layout.partnerFirst;
  const splitScreenOrientation = overlay.layout.type === "split-screen" ? overlay.layout.orientation : "horizontal";
  const isHorizontalSplit = splitScreenOrientation === "horizontal";

  const leadingStyle: CSSProperties = isHorizontalSplit
    ? { left: 0, top: 0, width: `${ratio * 100}%`, height: "100%" }
    : { left: 0, top: 0, width: "100%", height: `${ratio * 100}%` };
  const trailingStyle: CSSProperties = isHorizontalSplit
    ? { left: `${ratio * 100}%`, top: 0, width: `${(1 - ratio) * 100}%`, height: "100%" }
    : { left: 0, top: `${ratio * 100}%`, width: "100%", height: `${(1 - ratio) * 100}%` };
  const baseStyle = splitScreenPartnerFirst ? trailingStyle : leadingStyle;
  const overlayStyle = splitScreenPartnerFirst ? leadingStyle : trailingStyle;

  return (
    <div role="dialog" aria-modal="true" aria-label="Adjust framing" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-surface shadow-lg">
        <div className="flex items-center justify-between p-4 pb-0">
          <h2 className="text-sm font-semibold">Adjust framing</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-neutral-950 p-2">
            <div
              className="relative max-w-full"
              style={{
                height: "min(55vh, 480px)",
                maxWidth: "100%",
                aspectRatio: outputAspectRatio && outputAspectRatio > 0 ? `${outputAspectRatio}` : "16 / 9",
              }}
            >
              {isSplitScreen ? (
                <>
                  <CoverFramingRegion
                    styleRect={baseStyle}
                    frameUrl={baseFrameUrl}
                    framing={baseFraming}
                    onChange={setBaseFraming}
                    onSelect={() => setSelectedSide("base")}
                    highlighted={selectedSide === "base"}
                    borderColorClassName="border-foreground"
                    label="Main video"
                  />
                  <CoverFramingRegion
                    styleRect={overlayStyle}
                    frameUrl={overlayFrameUrl}
                    framing={framing}
                    onChange={setFraming}
                    onSelect={() => setSelectedSide("overlay")}
                    highlighted={selectedSide === "overlay"}
                    borderColorClassName={overlayBorderColorClassName}
                    label="Overlay photo"
                  />
                  <SplitScreenDivider orientation={splitScreenOrientation} ratio={ratio} onChange={setRatio} />
                </>
              ) : isPictureInPicture ? (
                <>
                  {baseFrameUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- a short-lived thumbnail data URL, not a Next-optimizable static asset
                    <img src={baseFrameUrl} alt="" className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover" />
                  )}
                  <PipFrame rect={pipRect} onChange={setPipRect} borderColorClassName={overlayBorderColorClassName}>
                    <CoverFramingRegion
                      styleRect={{ left: 0, top: 0, width: "100%", height: "100%" }}
                      frameUrl={overlayFrameUrl}
                      framing={framing}
                      onChange={setFraming}
                      highlighted={false}
                      borderColorClassName={overlayBorderColorClassName}
                      label="Overlay photo"
                      minZoom={MIN_PICTURE_IN_PICTURE_ZOOM}
                    />
                  </PipFrame>
                </>
              ) : (
                <CoverFramingRegion
                  styleRect={{ left: 0, top: 0, width: "100%", height: "100%" }}
                  frameUrl={overlayFrameUrl}
                  framing={framing}
                  onChange={setFraming}
                  highlighted
                  borderColorClassName={overlayBorderColorClassName}
                  label="Overlay photo"
                />
              )}
            </div>
          </div>

          <div className="flex w-full shrink-0 flex-col gap-4 sm:w-44">
            {isSplitScreen && (
              <p className="text-[11px] text-muted">
                Editing <span className="font-medium text-foreground">{activeSide === "base" ? "main video" : "overlay photo"}</span> -- click the other half to switch.
              </p>
            )}
            {!isSplitScreen && !isPictureInPicture && (
              <p className="text-[11px] text-muted">Drag the frame to choose which part stays in view.</p>
            )}
            {isPictureInPicture && (
              <p className="text-[11px] text-muted">
                Drag the box edge to move it, the corner to resize it, or the photo inside to choose which part stays in view.
              </p>
            )}

            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted">Flip / Mirror</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setActiveFraming({ ...activeFraming, flipHorizontal: !activeFraming.flipHorizontal })}
                  aria-pressed={activeFraming.flipHorizontal}
                  title="Flip"
                  className={
                    "rounded-sm border p-1.5 " +
                    (activeFraming.flipHorizontal ? "border-accent bg-accent/10 text-accent" : "border-border text-foreground hover:bg-background")
                  }
                >
                  <FlipHorizontalIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setActiveFraming({ ...activeFraming, flipVertical: !activeFraming.flipVertical })}
                  aria-pressed={activeFraming.flipVertical}
                  title="Mirror"
                  className={
                    "rounded-sm border p-1.5 " +
                    (activeFraming.flipVertical ? "border-accent bg-accent/10 text-accent" : "border-border text-foreground hover:bg-background")
                  }
                >
                  <FlipVerticalIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted">Zoom</span>
              <input
                type="range"
                min={isPictureInPicture ? MIN_PICTURE_IN_PICTURE_ZOOM : 1}
                max={3}
                step={0.05}
                value={activeFraming.zoom}
                onChange={(e) => setActiveFraming({ ...activeFraming, zoom: Number(e.target.value) })}
                title="Zoom into (or out of) the photo"
                className="h-1.5 w-full cursor-ew-resize accent-accent"
              />
              <span className="text-[10px] text-muted">{activeFraming.zoom.toFixed(2)}x</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 p-4 pt-0">
          <div className="flex items-center gap-3">
            <button type="button" onClick={handleReset} className="text-xs text-muted hover:text-foreground hover:underline">
              Reset
            </button>
            <button type="button" onClick={onDelete} className="text-xs text-red-600 hover:underline">
              Remove Overlay
            </button>
          </div>
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
