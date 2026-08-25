"use client";

/**
 * Popup for fine-tuning a video overlay -- opened from the crosshair button
 * on its VideoOverlayTrack segment. Two parts: the LEFT side shows the
 * actual FINAL FRAME (not an isolated source thumbnail) -- for Split
 * Screen, both halves at their real relative size with a draggable divider
 * between them; for Picture-in-Picture, the base frame with the PIP box
 * drawn on top at its real position; for Full-Screen, just the overlay's
 * own frame, since it's the only thing visible. Clicking/dragging inside
 * either half PANS that half's own footage (see CoverFramingRegion below);
 * for Split Screen, that same click also SELECTS which half the right
 * side's actions apply to. The RIGHT side holds Flip/Mirror (acting on
 * whichever half is selected) and a duplicate of VideoOverlayAudioTrack's
 * own audio-mix control, for convenience while already here.
 *
 * Every layout that crops footage into a differently-shaped box than its
 * own source does so via a "cover" fit (video_math.ts's
 * computeCoverFitSourceRect) -- rendered here with the equivalent native
 * CSS (`object-fit: cover` + `object-position`), so the preview IS the real
 * crop, not a stand-in. `panX`/`panY` (source-space, 0..1) are recovered
 * from a drag by converting the on-screen pixel delta into the matching
 * shift of that same cover-fit window (computeCoverPanDelta below) --
 * flipped footage negates the drag direction first, since the visible
 * image is mirrored via a CSS transform (applied AFTER the crop is chosen,
 * so it never changes which part of the source that crop keeps).
 *
 * Keeps its own local draft state and only commits on "Save" -- same
 * pattern as TextOverlayDialog/TranscriptCaptionDialog, not a live/commit
 * split against the outer edit history.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  computeCoverFitSourceRect,
  DEFAULT_OVERLAY_FRAMING,
  DEFAULT_SPLIT_SCREEN_RATIO,
  type CropRect,
  type OverlayFraming,
  type VideoOverlayClip,
} from "@/lib/video/video_math";
import { FlipHorizontalIcon, FlipVerticalIcon } from "@/components/icons/UIIcons";
import { LAYOUT_GRADIENT_TO_CLASSNAMES } from "./VideoOverlayAudioTrack";
import { VolumeFader } from "./VolumeFader";

// Keeps either half from being dragged down to a sliver too thin to grab
// or usefully see.
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;

/** Converts an on-screen drag delta (already flip-corrected by the caller)
 * into the resulting panX/panY, by shifting the SAME cover-fit source
 * window computeCoverFitSourceRect would place at the current pan, then
 * re-deriving the pan fraction that produces that shifted window. Falls
 * back to a plain box-fraction delta if the source's natural size isn't
 * known yet (e.g. the thumbnail hasn't finished loading) -- less precise,
 * but never wrong-directioned, and self-corrects once it loads since this
 * is recomputed fresh from the drag's own start point on every move. */
function computeCoverPanDelta(
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number,
  panX: number,
  panY: number,
  dxPx: number,
  dyPx: number
): { panX: number; panY: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return {
      panX: Math.min(Math.max(panX - dxPx / Math.max(boxWidth, 1), 0), 1),
      panY: Math.min(Math.max(panY - dyPx / Math.max(boxHeight, 1), 0), 1),
    };
  }
  const { sx, sy, sWidth, sHeight } = computeCoverFitSourceRect(naturalWidth, naturalHeight, boxWidth, boxHeight, panX, panY);
  const denomX = naturalWidth - sWidth;
  const denomY = naturalHeight - sHeight;
  const nextSx = sx - dxPx * (sWidth / boxWidth);
  const nextSy = sy - dyPx * (sHeight / boxHeight);
  return {
    panX: denomX > 0 ? Math.min(Math.max(nextSx / denomX, 0), 1) : panX,
    panY: denomY > 0 ? Math.min(Math.max(nextSy / denomY, 0), 1) : panY,
  };
}

/** One pannable region of the final-frame preview -- a cover-cropped,
 * optionally-mirrored image filling `styleRect`, draggable to repan (and,
 * when `onSelect` is given, selectable on the same gesture). */
function CoverFramingRegion({
  styleRect,
  frameUrl,
  framing,
  onChange,
  onSelect,
  highlighted,
  borderColorClassName,
  label,
}: {
  styleRect: CSSProperties;
  frameUrl: string;
  framing: OverlayFraming;
  onChange: (framing: OverlayFraming) => void;
  onSelect?: () => void;
  highlighted: boolean;
  borderColorClassName: string;
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  function handlePointerDown(e: React.PointerEvent) {
    onSelect?.();
    const measuredRect = containerRef.current?.getBoundingClientRect();
    if (!measuredRect) return;
    // Narrowed into its own definitely-assigned binding -- TS doesn't carry
    // the `if (!rect) return` narrowing above into the nested functions
    // below (they're not inline arrow functions the control-flow analyzer
    // re-checks), so it'd otherwise still see `rect` as possibly undefined.
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
        naturalWidth, naturalHeight, rect.width, rect.height, startFraming.panX, startFraming.panY, effectiveDx, effectiveDy
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
        // eslint-disable-next-line @next/next/no-img-element -- a short-lived thumbnail data URL, not a Next-optimizable static asset
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
      )}
    </div>
  );
}

/** The draggable boundary between Split Screen's two halves -- reads its
 * own container's rect off its parent (the preview box) rather than
 * needing a shared ref threaded down from the dialog. */
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


const LAYOUT_BORDER_COLOR_CLASSNAMES = {
  "full-screen": "border-amber-500",
  "picture-in-picture": "border-violet-500",
  "split-screen": "border-teal-500",
};

type SelectedSide = "base" | "overlay";

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
  // -- shown for Split Screen (its own half) and Picture-in-Picture (the
  // backdrop the PIP box sits on).
  baseFrameUrl: string;
  overlayFrameUrl: string;
  outputAspectRatio: number | null;
  onSave: (framing: OverlayFraming, options?: { baseFraming?: OverlayFraming; ratio?: number; audioBalance?: number }) => void;
  onClose: () => void;
}) {
  const isSplitScreen = overlay.layout.type === "split-screen";

  const [framing, setFraming] = useState(overlay.framing);
  // `?? DEFAULT_*`: both fields were added to the split-screen layout after
  // some projects already had one persisted without them -- see
  // CanvasPlayer.tsx's identical fallback for the full explanation.
  const [baseFraming, setBaseFraming] = useState(
    overlay.layout.type === "split-screen" ? overlay.layout.baseFraming ?? DEFAULT_OVERLAY_FRAMING : DEFAULT_OVERLAY_FRAMING
  );
  const [ratio, setRatio] = useState(
    overlay.layout.type === "split-screen" ? overlay.layout.ratio ?? DEFAULT_SPLIT_SCREEN_RATIO : DEFAULT_SPLIT_SCREEN_RATIO
  );
  const [audioBalance, setAudioBalance] = useState(overlay.audioBalance);
  // Which half the right-hand actions apply to -- only meaningful (and only
  // ever shown) for Split Screen, where there genuinely are two frameable
  // halves; Full-Screen/Picture-in-Picture only ever have the overlay's own
  // footage to frame, so this stays fixed at "overlay" for those.
  const [selectedSide, setSelectedSide] = useState<SelectedSide>("overlay");

  // Re-syncs if a different overlay's framing dialog is opened while this
  // one is already mounted (same reasoning as TextOverlayDialog's own
  // re-sync effect).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFraming(overlay.framing);
    setBaseFraming(overlay.layout.type === "split-screen" ? overlay.layout.baseFraming ?? DEFAULT_OVERLAY_FRAMING : DEFAULT_OVERLAY_FRAMING);
    setRatio(overlay.layout.type === "split-screen" ? overlay.layout.ratio ?? DEFAULT_SPLIT_SCREEN_RATIO : DEFAULT_SPLIT_SCREEN_RATIO);
    setAudioBalance(overlay.audioBalance);
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
      audioBalance,
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

  const pipRect: CropRect | null = overlay.layout.type === "picture-in-picture" ? overlay.layout.rect : null;

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
            {/* Height-first sizing (not width-first): the aspect-ratio box's
                HEIGHT is the definite dimension (capped well under the
                dialog's own max-height), and width is DERIVED from it --
                the reverse of just setting width:100% would, for a tall
                portrait reel, blow the preview's height way past the
                viewport (the exact overflow this replaced). maxWidth is
                only a safety clamp for the rare very-wide-output-in-a-
                short-viewport case. */}
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
                    label="Overlay video"
                  />
                  <SplitScreenDivider orientation={splitScreenOrientation} ratio={ratio} onChange={setRatio} />
                </>
              ) : overlay.layout.type === "picture-in-picture" && pipRect ? (
                <>
                  {baseFrameUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- a short-lived thumbnail data URL, not a Next-optimizable static asset
                    <img src={baseFrameUrl} alt="" className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover" />
                  )}
                  <CoverFramingRegion
                    styleRect={{ left: `${pipRect.x * 100}%`, top: `${pipRect.y * 100}%`, width: `${pipRect.width * 100}%`, height: `${pipRect.height * 100}%` }}
                    frameUrl={overlayFrameUrl}
                    framing={framing}
                    onChange={setFraming}
                    highlighted
                    borderColorClassName={overlayBorderColorClassName}
                    label="Overlay video"
                  />
                </>
              ) : (
                <CoverFramingRegion
                  styleRect={{ left: 0, top: 0, width: "100%", height: "100%" }}
                  frameUrl={overlayFrameUrl}
                  framing={framing}
                  onChange={setFraming}
                  highlighted
                  borderColorClassName={overlayBorderColorClassName}
                  label="Overlay video"
                />
              )}
            </div>
          </div>

          <div className="flex w-full shrink-0 flex-col gap-4 sm:w-44">
            {isSplitScreen && (
              <p className="text-[11px] text-muted">
                Editing <span className="font-medium text-foreground">{activeSide === "base" ? "main video" : "overlay video"}</span> -- click the other half to switch.
              </p>
            )}
            {!isSplitScreen && <p className="text-[11px] text-muted">Drag the frame to choose which part stays in view.</p>}

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
              <span className="text-[11px] font-medium text-muted">Sound</span>
              <VolumeFader value={audioBalance} onChange={setAudioBalance} colorClassName={LAYOUT_GRADIENT_TO_CLASSNAMES[overlay.layout.type]} />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 p-4 pt-0">
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
