"use client";

/**
 * The authoring dialog for a Text Slide (video_math.ts's SequenceEntry
 * "text" variant) -- a full-frame slide of authored text and/or an image,
 * with its own duration and entrance/exit animation, inserted as its own
 * segment in the base sequence (see CutawayDialog.tsx for the sibling
 * "photo animated via Ken Burns" segment kind -- this is a separate
 * dialog, not a third mode bolted onto that one, since the authoring UI
 * here is genuinely different; see this feature's own plan doc).
 *
 * Text is authored via a plain multi-line textarea -- same "no font/color/
 * animation knobs in the text field itself" convention as TextOverlayDialog.tsx.
 * Bold/Italic/alignment/color are separate, WHOLE-SLIDE toggles next to it
 * instead (a style choice, not per-run formatting) -- see video_math.ts's
 * own "text" variant doc comment for why. The textarea's value round-trips
 * straight through to the persisted `text` field (newlines and all), the
 * same shape textSlideRenderer.ts's drawTextSlide (via textTemplates.ts's
 * fitTextToRect) already wraps/auto-shrinks -- preview and export can't
 * drift since both call that exact same renderer.
 *
 * Reopened in EDIT mode (via the `editing` prop) by clicking an existing
 * "text" segment on the Cutaways rail (CutawayTrack.tsx) -- same
 * add-vs-edit duality as CutawayDialog's own `editing` prop, and the same
 * "standalone preview canvas loops the real renderer" principle as that
 * dialog's own preview (see its own module comment).
 */
import { useEffect, useRef, useState } from "react";
import type { Asset } from "@/lib/api";
import { useCrossOriginImageSrcMap } from "@/lib/useCrossOriginImageSrc";
import { loadCrossOriginImage } from "@/lib/crossOriginImage";
import { drawTextSlide, type TextSlideEntry } from "@/lib/video/textSlideRenderer";
import type { TextSlideStyle, TextSlideLayout } from "@/lib/video/transformations";
import { DEFAULT_IMAGE_CLIP_DURATION_SECONDS, MIN_IMAGE_CLIP_DURATION_SECONDS, MAX_IMAGE_CLIP_DURATION_SECONDS } from "@/lib/video/transformations";
import { TEXT_SLIDE_TRANSITION_OPTIONS, type TextSlideTransitionId } from "@/lib/video/textSlideTransitions";
import { DEFAULT_CANVAS_FILL_GRADIENT_COLOR } from "@/lib/video/canvasFillPresets";

const PREVIEW_CANVAS_HEIGHT = 540;
const DURATION_STEP_SECONDS = 0.5;
const DEFAULT_TEXT_SLIDE_STYLE: TextSlideStyle = { bold: false, italic: false, align: "center", color: "#ffffff" };
const DEFAULT_TEXT_SLIDE_FILL_COLOR = "#111827";
const TEXT_COLOR_SWATCHES = ["#ffffff", "#111827", "#facc15", "#f472b6", "#38bdf8", "#4ade80"];
const FILL_COLOR_SWATCHES = ["#111827", "#0f172a", "#7c2d12", "#134e4a", "#4c1d95", "#ffffff"];
const DEFAULT_PREVIEW_TEXT = "Your text here";

const LAYOUT_OPTIONS: { id: TextSlideLayout; name: string }[] = [
  { id: "text-only", name: "Text only" },
  { id: "image-full", name: "Image background" },
  { id: "image-left", name: "Image left" },
  { id: "image-right", name: "Image right" },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function TransitionIcon({ id, className }: { id: TextSlideTransitionId; className?: string }) {
  if (id === "none") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
        <circle cx="12" cy="12" r="7" />
      </svg>
    );
  }
  if (id === "fade") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
        <circle cx="12" cy="12" r="7" strokeDasharray="3 3" />
      </svg>
    );
  }
  const rotation = { right: 0, bottom: 90, left: 180, top: 270 }[id];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <path d="M4 12h16M13 5l7 7-7 7" />
    </svg>
  );
}

function TransitionPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: TextSlideTransitionId;
  onChange: (id: TextSlideTransitionId) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] text-muted">{label}</p>
      <div className="grid grid-cols-6 gap-1">
        {TEXT_SLIDE_TRANSITION_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            title={option.name}
            className={
              "flex flex-col items-center justify-center gap-0.5 rounded-md border-2 bg-background py-1 " +
              (value === option.id ? "border-accent" : "border-transparent")
            }
          >
            <TransitionIcon id={option.id} className="h-3.5 w-3.5 text-foreground" />
            <span className="text-[8px] text-muted">{option.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function TextSlideDialog({
  assets,
  clipRectAspectRatio,
  editing,
  onSave,
  onClose,
  onDelete,
}: {
  assets: Asset[];
  /** The project's selected clip-rectangle shape (width/height) -- the
   * preview canvas is sized to match, since a text slide fills the WHOLE
   * frame (unlike a Cutaway photo, there's no separately-positioned crop
   * rectangle here). */
  clipRectAspectRatio: number;
  /** Non-null when this dialog was reopened from the Cutaways rail to edit
   * an existing text slide rather than add a fresh one. */
  editing?: {
    text: string;
    style: TextSlideStyle;
    layout: TextSlideLayout;
    assetId: string;
    canvasFillMode: "solid" | "gradient" | null;
    canvasFillColor?: string;
    canvasFillGradientColor?: string;
    entranceId: TextSlideTransitionId;
    exitId: TextSlideTransitionId;
    durationSeconds: number;
  } | null;
  onSave: (
    text: string,
    style: TextSlideStyle,
    layout: TextSlideLayout,
    durationSeconds: number,
    entranceId: TextSlideTransitionId,
    exitId: TextSlideTransitionId,
    assetId?: string | null,
    canvasFillMode?: "solid" | "gradient" | null,
    canvasFillColor?: string,
    canvasFillGradientColor?: string
  ) => void;
  onClose: () => void;
  // Only ever passed (and only ever shown) in edit mode -- there's no
  // existing slide to remove yet while adding a fresh one.
  onDelete?: () => void;
}) {
  const isEditing = Boolean(editing);
  const imageAssets = assets.filter((asset) => asset.kind === "image");
  // Photo-picker thumbnails must never load asset.url via a plain <img> --
  // see useCrossOriginImageSrcMap's own comment for why that can poison
  // the browser's cache against the live preview's later CORS-mode fetch
  // of the exact same URL.
  const imageThumbnailSrcById = useCrossOriginImageSrcMap(imageAssets.map((asset) => ({ id: asset.id, url: asset.url })));

  const [text, setText] = useState(editing?.text ?? "");
  const [style, setStyle] = useState<TextSlideStyle>(editing?.style ?? DEFAULT_TEXT_SLIDE_STYLE);
  const [layout, setLayout] = useState<TextSlideLayout>(editing?.layout ?? "text-only");
  const [selectedImageAssetId, setSelectedImageAssetId] = useState<string | null>(
    editing?.assetId || imageAssets[0]?.id || null
  );
  const [canvasFillMode, setCanvasFillMode] = useState<"solid" | "gradient">(editing?.canvasFillMode ?? "solid");
  const [canvasFillColor, setCanvasFillColor] = useState(editing?.canvasFillColor ?? DEFAULT_TEXT_SLIDE_FILL_COLOR);
  const [canvasFillGradientColor, setCanvasFillGradientColor] = useState(
    editing?.canvasFillGradientColor ?? DEFAULT_CANVAS_FILL_GRADIENT_COLOR
  );
  const [entranceId, setEntranceId] = useState<TextSlideTransitionId>(editing?.entranceId ?? "fade");
  const [exitId, setExitId] = useState<TextSlideTransitionId>(editing?.exitId ?? "fade");
  const [durationSeconds, setDurationSeconds] = useState(editing?.durationSeconds ?? DEFAULT_IMAGE_CLIP_DURATION_SECONDS);

  const needsImage = layout !== "text-only";
  // Backdrop color/gradient applies to every layout except "image-full" --
  // that one's image already covers the whole frame with its own fixed
  // scrim (see textSlideRenderer.ts) -- see video_math.ts's own comment on
  // the "text" variant's canvasFillMode field.
  const showFillPicker = layout !== "image-full";
  const selectedImageAsset = imageAssets.find((asset) => asset.id === selectedImageAssetId) ?? null;

  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!needsImage || !selectedImageAsset) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop/selection-driven dependency change, same pattern as CutawayDialog's own re-sync effects
      setLoadedImage(null);
      return;
    }
    let cancelled = false;
    let ownBlobUrl: string | null = null;
    loadCrossOriginImage(selectedImageAsset.url)
      .then(({ image, blobUrl }) => {
        if (cancelled) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        ownBlobUrl = blobUrl;
        setLoadedImage(image);
      })
      .catch(() => {
        if (!cancelled) setLoadedImage(null);
      });
    return () => {
      cancelled = true;
      if (ownBlobUrl) URL.revokeObjectURL(ownBlobUrl);
    };
  }, [needsImage, selectedImageAsset]);

  const canvasWidth = Math.round(PREVIEW_CANVAS_HEIGHT * clipRectAspectRatio);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Loops drawTextSlide over the authored duration -- the exact same
  // renderer CanvasPlayer.tsx/exportTimeline.ts call once this slide is
  // actually added, so what's previewed here can't drift from what
  // actually gets committed (same principle CutawayDialog's own preview
  // states for its Ken Burns animation).
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const previewEntry: TextSlideEntry = {
      id: "preview",
      kind: "text",
      durationSeconds,
      text: text.trim() || DEFAULT_PREVIEW_TEXT,
      style,
      layout,
      assetId: selectedImageAssetId ?? "",
      canvasFillMode: showFillPicker ? canvasFillMode : null,
      canvasFillColor,
      canvasFillGradientColor,
      entranceId,
      exitId,
    };

    let rafId: number;
    let startTimestamp: number | null = null;
    function draw(timestamp: number) {
      if (startTimestamp === null) startTimestamp = timestamp;
      const elapsedRaw = ((timestamp - (startTimestamp ?? 0)) / 1000) % durationSeconds;
      const elapsed = clamp(elapsedRaw, 0.001, durationSeconds - 0.001);
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      drawTextSlide(ctx!, previewEntry, { x: 0, y: 0, width: canvas!.width, height: canvas!.height }, elapsed, loadedImage);
      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [
    text,
    style,
    layout,
    selectedImageAssetId,
    showFillPicker,
    canvasFillMode,
    canvasFillColor,
    canvasFillGradientColor,
    entranceId,
    exitId,
    durationSeconds,
    loadedImage,
  ]);

  // Drag-to-stretch the duration bar's right edge -- same mechanics as
  // CutawayDialog's own duration handle.
  const dragStateRef = useRef<{ startClientX: number; startDuration: number } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  function handleDurationHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = { startClientX: e.clientX, startDuration: durationSeconds };
  }
  function handleDurationHandlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    const trackWidthPx = trackRef.current?.clientWidth ?? 1;
    if (!drag) return;
    const deltaSeconds = ((e.clientX - drag.startClientX) / trackWidthPx) * (MAX_IMAGE_CLIP_DURATION_SECONDS - MIN_IMAGE_CLIP_DURATION_SECONDS);
    setDurationSeconds(clamp(drag.startDuration + deltaSeconds, MIN_IMAGE_CLIP_DURATION_SECONDS, MAX_IMAGE_CLIP_DURATION_SECONDS));
  }
  function handleDurationHandlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    dragStateRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }
  const durationFraction = (durationSeconds - MIN_IMAGE_CLIP_DURATION_SECONDS) / (MAX_IMAGE_CLIP_DURATION_SECONDS - MIN_IMAGE_CLIP_DURATION_SECONDS);

  function handleSave() {
    if (!text.trim()) return;
    if (needsImage && !selectedImageAssetId) return;
    onSave(
      text.trim(),
      style,
      layout,
      durationSeconds,
      entranceId,
      exitId,
      needsImage ? selectedImageAssetId : null,
      showFillPicker ? canvasFillMode : undefined,
      canvasFillColor,
      canvasFillGradientColor
    );
  }

  const canSave = text.trim().length > 0 && (!needsImage || Boolean(selectedImageAssetId));

  return (
    <div role="dialog" aria-modal="true" aria-label="Text Slide" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="flex h-[85vh] w-full max-w-4xl flex-col rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{isEditing ? "Edit Text Slide" : "Text Slide"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="mb-3 flex min-h-0 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black" style={{ flexBasis: "38%" }}>
          <canvas ref={canvasRef} width={canvasWidth} height={PREVIEW_CANVAS_HEIGHT} className="h-full w-full object-contain" />
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-2 gap-4 overflow-y-auto">
          {/* Left column -- the text itself. */}
          <div className="flex min-h-0 flex-col gap-2">
            <p className="text-[11px] text-muted">Text</p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type your text…"
              rows={4}
              className="min-h-[6rem] w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />

            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-pressed={style.bold}
                onClick={() => setStyle((s) => ({ ...s, bold: !s.bold }))}
                title="Bold"
                className={"h-6 w-6 rounded-md border text-xs font-bold " + (style.bold ? "border-accent bg-accent/20 text-accent" : "border-border text-foreground")}
              >
                B
              </button>
              <button
                type="button"
                aria-pressed={style.italic}
                onClick={() => setStyle((s) => ({ ...s, italic: !s.italic }))}
                title="Italic"
                className={"h-6 w-6 rounded-md border text-xs italic " + (style.italic ? "border-accent bg-accent/20 text-accent" : "border-border text-foreground")}
              >
                I
              </button>
              <div className="flex gap-1 rounded-md border border-border p-0.5">
                {(["left", "center", "right"] as const).map((align) => (
                  <button
                    key={align}
                    type="button"
                    onClick={() => setStyle((s) => ({ ...s, align }))}
                    title={`Align ${align}`}
                    className={"rounded-sm px-1.5 py-0.5 text-[10px] capitalize " + (style.align === align ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground")}
                  >
                    {align}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                {TEXT_COLOR_SWATCHES.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setStyle((s) => ({ ...s, color }))}
                    title={color}
                    className={"h-5 w-5 rounded-full border-2 " + (style.color === color ? "border-accent" : "border-transparent")}
                    style={{ backgroundColor: color }}
                  />
                ))}
                <input
                  type="color"
                  value={style.color}
                  onChange={(e) => setStyle((s) => ({ ...s, color: e.target.value }))}
                  title="Custom text color"
                  className="h-5 w-6 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
                />
              </div>
            </div>
          </div>

          {/* Right column -- layout, image/background, transitions, duration. */}
          <div className="flex min-h-0 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-[11px] text-muted">Layout</p>
              <div className="grid grid-cols-4 gap-1">
                {LAYOUT_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setLayout(option.id)}
                    className={"rounded-md border-2 bg-background px-1 py-1.5 text-[10px] " + (layout === option.id ? "border-accent text-accent" : "border-transparent text-muted hover:text-foreground")}
                  >
                    {option.name}
                  </button>
                ))}
              </div>
            </div>

            {needsImage && (
              <div className="flex flex-col gap-1">
                <p className="text-[11px] text-muted">Choose a photo</p>
                <div className="flex max-h-16 items-center gap-2 overflow-x-auto">
                  {imageAssets.length === 0 && <p className="text-xs text-muted">No photos in this project yet</p>}
                  {imageAssets.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      title={asset.filename}
                      onClick={() => setSelectedImageAssetId(asset.id)}
                      className={"aspect-square h-14 shrink-0 overflow-hidden rounded-md border-2 " + (selectedImageAssetId === asset.id ? "border-accent" : "border-transparent")}
                    >
                      {imageThumbnailSrcById[asset.id] && (
                        // eslint-disable-next-line @next/next/no-img-element -- a blob: URL from a safe CORS-mode fetch, not a Next-optimizable static asset
                        <img src={imageThumbnailSrcById[asset.id]} alt={asset.filename} className="h-full w-full object-cover" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {showFillPicker && (
              <div className="flex flex-col gap-1">
                <p className="text-[11px] text-muted">{layout === "text-only" ? "Background" : "Backdrop behind the text"}</p>
                <div className="flex items-center gap-2">
                  <div className="flex gap-1 rounded-md border border-border p-0.5">
                    {(["solid", "gradient"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setCanvasFillMode(mode)}
                        className={"rounded-sm px-1.5 py-0.5 text-[10px] capitalize " + (canvasFillMode === mode ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground")}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  {FILL_COLOR_SWATCHES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setCanvasFillColor(color)}
                      title={color}
                      className={"h-5 w-5 rounded-full border-2 " + (canvasFillColor === color ? "border-accent" : "border-transparent")}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                  <input
                    type="color"
                    value={canvasFillColor}
                    onChange={(e) => setCanvasFillColor(e.target.value)}
                    title="Custom background color"
                    className="h-5 w-6 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  {canvasFillMode === "gradient" && (
                    <input
                      type="color"
                      value={canvasFillGradientColor}
                      onChange={(e) => setCanvasFillGradientColor(e.target.value)}
                      title="Gradient's second color"
                      className="h-5 w-6 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
                    />
                  )}
                </div>
              </div>
            )}

            <TransitionPicker label="Entrance" value={entranceId} onChange={setEntranceId} />
            <TransitionPicker label="Exit" value={exitId} onChange={setExitId} />

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDurationSeconds((d) => clamp(d - DURATION_STEP_SECONDS, MIN_IMAGE_CLIP_DURATION_SECONDS, MAX_IMAGE_CLIP_DURATION_SECONDS))}
                className="h-6 w-6 shrink-0 rounded-md border border-border text-sm text-foreground hover:bg-background"
                aria-label="Shorten duration"
              >
                −
              </button>
              <div ref={trackRef} className="relative h-2 flex-1 rounded-full bg-neutral-800">
                <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${durationFraction * 100}%` }} />
                <div
                  onPointerDown={handleDurationHandlePointerDown}
                  onPointerMove={handleDurationHandlePointerMove}
                  onPointerUp={handleDurationHandlePointerUp}
                  className="absolute top-1/2 h-4 w-4 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-accent bg-background"
                  style={{ left: `calc(${durationFraction * 100}% - 8px)` }}
                />
              </div>
              <button
                type="button"
                onClick={() => setDurationSeconds((d) => clamp(d + DURATION_STEP_SECONDS, MIN_IMAGE_CLIP_DURATION_SECONDS, MAX_IMAGE_CLIP_DURATION_SECONDS))}
                className="h-6 w-6 shrink-0 rounded-md border border-border text-sm text-foreground hover:bg-background"
                aria-label="Lengthen duration"
              >
                +
              </button>
              <span className="w-10 shrink-0 text-right text-xs text-muted">{durationSeconds.toFixed(1)}s</span>
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 border-t border-border pt-2">
          {isEditing && onDelete && (
            <button type="button" onClick={onDelete} className="text-xs text-red-600 hover:underline">
              Remove Text Slide
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-border py-1.5 px-3 text-sm font-medium text-foreground hover:bg-background">
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={handleSave}
              className="rounded-md bg-accent py-1.5 px-3 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              {isEditing ? "Save changes" : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
