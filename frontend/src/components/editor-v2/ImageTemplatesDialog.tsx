"use client";

/**
 * "Image Cutaway" toolbar tool -- turns one of this project's photos into
 * its own full-screen clip in the base sequence, animated via one or more
 * combined Ken Burns templates (lib/video/imageTemplates.ts). Three STACKED
 * horizontal panels (not the left/right split TranscriptCaptionDialog/
 * TextOverlayDialog use), per spec: pick the photo, pick the motion(s),
 * position the clip rectangle + tune the preview/duration, Add.
 *
 * Reopened in EDIT mode (via the `editing` prop) by clicking an existing
 * segment on the Cutaways rail (CutawayTrack.tsx) -- same three panels,
 * pre-populated from that cutaway's current photo/template(s)/duration/
 * cropRect, with "Add to video" relabeled "Save changes". The caller
 * (ThreePaneEditor) decides whether `onAdd` should append a new clip or
 * edit the existing one in place; this dialog itself doesn't know the
 * difference beyond the copy change.
 *
 * The animated preview here is intentionally a standalone canvas, not
 * CanvasPlayer: there's no real sequence position for a NEW clip yet (it
 * doesn't exist until "Add to video" is pressed), so it just loops the
 * chosen template(s)' ZoomEffect over the chosen image directly, using the
 * exact same buildKenBurnsEffect + computeEffectiveCropRect the real clip
 * will use once added/saved (transformations.ts's
 * applyAddImageSequenceClip / applyEditImageSequenceClip) -- what's
 * previewed here can't drift from what actually gets committed.
 *
 * Positioning: the animation's `base` rect used to come straight from the
 * project's overall video-frame clip rectangle, applied as if it were
 * fractions of the PHOTO -- a real bug, since a photo's own dimensions are
 * unrelated to the video frame's. Now the user sees the reel's clip-
 * rectangle SHAPE (locked to `clipRectAspectRatio`) drawn directly on the
 * actual photo and drags/resizes it into place (via CropRectOverlay, the
 * same move+aspect-locked-resize interaction the main clip-rectangle editor
 * on FrameStrip already uses) -- that positioned rect, in fractions of the
 * photo itself, is what's actually persisted and animated from.
 */
import { useEffect, useRef, useState } from "react";
import type { Asset } from "@/lib/api";
import { computeEffectiveCropRect, computeMaxCoverageCropFraction, FULL_FRAME_CROP_RECT, type CropRect } from "@/lib/video/video_math";
import { IMAGE_TEMPLATE_AXES, IMAGE_TEMPLATE_OPTIONS, buildKenBurnsEffect, type ImageTemplateId } from "@/lib/video/imageTemplates";
import { CropRectOverlay } from "./CropRectOverlay";
import {
  DEFAULT_IMAGE_CLIP_DURATION_SECONDS,
  MIN_IMAGE_CLIP_DURATION_SECONDS,
  MAX_IMAGE_CLIP_DURATION_SECONDS,
} from "@/lib/video/transformations";

const PREVIEW_CANVAS_WIDTH = 960;
const PREVIEW_CANVAS_HEIGHT = 540;
const DURATION_STEP_SECONDS = 0.5;
// How close a persisted cropRect's own aspect ratio needs to be to the
// project's CURRENT clip-rectangle ratio to trust it as-is when reopening a
// cutaway for edit -- a wider tolerance would risk reusing a rect authored
// for a since-changed project ratio, silently distorting the photo.
const RATIO_MATCH_TOLERANCE = 0.01;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** A single directional arrow, rotated per template -- pan-left/right/up/down
 * all reuse this one glyph. */
function PanArrowIcon({ direction, className }: { direction: "left" | "right" | "up" | "down"; className?: string }) {
  const rotation = { right: 0, down: 90, left: 180, up: 270 }[direction];
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

function ZoomIcon({ zoomIn, className }: { zoomIn: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
      {zoomIn ? <path d="M10.5 7.5v6M7.5 10.5h6" /> : <path d="M7.5 10.5h6" />}
    </svg>
  );
}

function TemplateIcon({ id, className }: { id: ImageTemplateId; className?: string }) {
  switch (id) {
    case "zoom-in":
      return <ZoomIcon zoomIn className={className} />;
    case "zoom-out":
      return <ZoomIcon zoomIn={false} className={className} />;
    case "pan-left":
      return <PanArrowIcon direction="left" className={className} />;
    case "pan-right":
      return <PanArrowIcon direction="right" className={className} />;
    case "pan-up":
      return <PanArrowIcon direction="up" className={className} />;
    case "pan-down":
      return <PanArrowIcon direction="down" className={className} />;
  }
}

export function ImageTemplatesDialog({
  assets,
  clipRectAspectRatio,
  editing,
  onAdd,
  onClose,
  onDelete,
}: {
  assets: Asset[];
  /** The project's selected clip-rectangle shape (width/height) -- e.g.
   * ActionArea's playAreaRatio -- the photo's own positioned crop
   * rectangle is locked to this ratio, same as the main clip rectangle. */
  clipRectAspectRatio: number;
  /** Non-null when this dialog was reopened from the Cutaways rail to edit
   * an existing cutaway rather than add a fresh one -- pre-populates the
   * panels from its current photo/template(s)/duration/cropRect and
   * relabels the primary button. */
  editing?: { assetId: string; templateIds: string[]; durationSeconds: number; cropRect: CropRect | null } | null;
  onAdd: (assetId: string, durationSeconds: number, templateIds: string[], cropRect: CropRect) => void;
  onClose: () => void;
  // Only ever passed (and only ever shown) in edit mode -- there's no
  // existing cutaway to remove yet while adding a fresh one.
  onDelete?: () => void;
}) {
  const imageAssets = assets.filter((asset) => asset.kind === "image");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(editing?.assetId ?? imageAssets[0]?.id ?? null);
  const [templateIds, setTemplateIds] = useState<ImageTemplateId[]>(
    (editing?.templateIds as ImageTemplateId[] | undefined) ?? [IMAGE_TEMPLATE_OPTIONS[0].id]
  );
  const [durationSeconds, setDurationSeconds] = useState(editing?.durationSeconds ?? DEFAULT_IMAGE_CLIP_DURATION_SECONDS);

  const selectedAsset = imageAssets.find((asset) => asset.id === selectedAssetId) ?? null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  // The clip rectangle positioned for THIS photo, as fractions (0..1) of
  // the photo's own naturalWidth/naturalHeight -- null until the photo has
  // loaded and a default (or the persisted rect) has been seeded, see the
  // effect below.
  const [photoCropRect, setPhotoCropRect] = useState<CropRect | null>(null);

  // Loads the selected photo once per asset change -- a plain <img>, not
  // extraction of any kind, since it's already a static file.
  useEffect(() => {
    if (!selectedAsset) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change, same pattern as TranscriptCaptionDialog's own re-sync effect
      setLoadedImage(null);
      return;
    }
    let cancelled = false;
    const img = new window.Image();
    img.onload = () => {
      if (!cancelled) setLoadedImage(img);
    };
    img.src = selectedAsset.url;
    return () => {
      cancelled = true;
    };
  }, [selectedAsset]);

  // Seeds photoCropRect once the photo's natural size is known: restores
  // the persisted rect when reopening THIS SAME photo for edit (and its
  // aspect ratio still matches the project's current clip-rectangle ratio
  // -- if the project's ratio changed since this cutaway was authored, the
  // stale rect would silently distort the photo, so it's discarded
  // instead), otherwise seeds the max-coverage default for this photo/ratio
  // combination -- same helper ClipRectangleDialog uses for the project's
  // own clip rectangle.
  useEffect(() => {
    if (!loadedImage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change
      setPhotoCropRect(null);
      return;
    }
    const photoAspectRatio = loadedImage.naturalWidth / loadedImage.naturalHeight;
    const persisted = editing && editing.assetId === selectedAssetId ? editing.cropRect : null;
    const persistedRatioMatches =
      persisted != null && Math.abs(persisted.width / persisted.height - clipRectAspectRatio) < RATIO_MATCH_TOLERANCE;
    setPhotoCropRect(persistedRatioMatches ? persisted : computeMaxCoverageCropFraction(photoAspectRatio, clipRectAspectRatio));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `editing` is only read for its value at the moment loadedImage/selectedAssetId change; it can't change mid-lifetime since this dialog fully remounts each time it reopens (see ActionArea's conditional render)
  }, [loadedImage, selectedAssetId, clipRectAspectRatio]);

  // Loops the chosen template(s)' combined motion over the loaded image,
  // redrawing every frame -- reuses computeEffectiveCropRect/
  // buildKenBurnsEffect verbatim, the exact math the real added clip will
  // use.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !loadedImage || !photoCropRect) return;

    const zoomEffect = buildKenBurnsEffect(templateIds, photoCropRect, 0, durationSeconds);
    let rafId: number;
    let startTimestamp: number | null = null;

    function draw(timestamp: number) {
      if (startTimestamp === null) startTimestamp = timestamp;
      const elapsedRaw = ((timestamp - (startTimestamp ?? 0)) / 1000) % durationSeconds;
      // Nudged off the exact boundaries -- computeEffectiveCropRect's
      // active-effect check is strictly-between, so t=0 exactly would
      // read as "no effect active" and show the un-animated base rect for
      // one frame every loop.
      const elapsed = clamp(elapsedRaw, 0.001, durationSeconds - 0.001);
      const crop = computeEffectiveCropRect(photoCropRect ?? FULL_FRAME_CROP_RECT, [zoomEffect], elapsed);

      // Non-null: `canvas`/`ctx`/`loadedImage` were all checked just above --
      // TypeScript doesn't carry that narrowing into this nested closure.
      const img = loadedImage!;
      const sx = crop.x * img.naturalWidth;
      const sy = crop.y * img.naturalHeight;
      const sw = crop.width * img.naturalWidth;
      const sh = crop.height * img.naturalHeight;
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx!.drawImage(img, sx, sy, sw, sh, 0, 0, canvas!.width, canvas!.height);

      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [loadedImage, templateIds, durationSeconds, photoCropRect]);

  // Toggles one template id, one pick per axis (zoom / horizontal pan /
  // vertical pan) -- picking a second id from the SAME axis as an existing
  // pick swaps it out; picking one from a DIFFERENT axis adds it alongside
  // (combining into one motion). At least one axis stays selected at all
  // times. Re-sorted to IMAGE_TEMPLATE_OPTIONS' own order so the persisted
  // array (and its tooltip/preview) is always deterministic regardless of
  // click order.
  function handleToggleTemplate(id: ImageTemplateId) {
    setTemplateIds((prev) => {
      const axis = IMAGE_TEMPLATE_AXES[id];
      const withoutSameAxis = prev.filter((existingId) => IMAGE_TEMPLATE_AXES[existingId] !== axis);
      const next = prev.includes(id) ? withoutSameAxis : [...withoutSameAxis, id];
      if (next.length === 0) return prev;
      return IMAGE_TEMPLATE_OPTIONS.filter((option) => next.includes(option.id)).map((option) => option.id);
    });
  }

  // Drag-to-stretch the duration bar's right edge -- pointer capture keeps
  // the drag tracking even if the pointer leaves the handle's own bounds.
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
    const deltaSeconds =
      ((e.clientX - drag.startClientX) / trackWidthPx) * (MAX_IMAGE_CLIP_DURATION_SECONDS - MIN_IMAGE_CLIP_DURATION_SECONDS);
    setDurationSeconds(
      clamp(drag.startDuration + deltaSeconds, MIN_IMAGE_CLIP_DURATION_SECONDS, MAX_IMAGE_CLIP_DURATION_SECONDS)
    );
  }
  function handleDurationHandlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    dragStateRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const durationFraction =
    (durationSeconds - MIN_IMAGE_CLIP_DURATION_SECONDS) /
    (MAX_IMAGE_CLIP_DURATION_SECONDS - MIN_IMAGE_CLIP_DURATION_SECONDS);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image Cutaway"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{editing ? "Edit Image Cutaway" : "Image Cutaway"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        {/* Panel 1 (18%) -- photo picker. */}
        <div style={{ flexBasis: "18%" }} className="mb-3 flex min-h-0 shrink-0 flex-col gap-1.5">
          <p className="text-[11px] text-muted">Choose a photo</p>
          <div className="flex flex-1 items-center gap-2 overflow-x-auto">
            {imageAssets.length === 0 && <p className="text-xs text-muted">No photos in this project yet</p>}
            {imageAssets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                title={asset.filename}
                onClick={() => setSelectedAssetId(asset.id)}
                className={
                  "aspect-square h-full shrink-0 overflow-hidden rounded-md border-2 " +
                  (selectedAssetId === asset.id ? "border-accent" : "border-transparent")
                }
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL, not a Next-optimizable static asset */}
                <img src={asset.url} alt={asset.filename} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        </div>

        {/* Panel 2 (28%) -- Ken Burns template picker, multi-select: one
            pick per axis, freely combinable across axes. */}
        <div style={{ flexBasis: "28%" }} className="mb-3 flex min-h-0 shrink-0 flex-col gap-1.5">
          <p className="text-[11px] text-muted">Choose one or more motions -- combine, e.g., a zoom with a pan</p>
          <div className="grid flex-1 grid-cols-3 gap-2">
            {IMAGE_TEMPLATE_OPTIONS.map((option) => {
              const isSelected = templateIds.includes(option.id);
              const axisRepresented = templateIds.some(
                (id) => IMAGE_TEMPLATE_AXES[id] === IMAGE_TEMPLATE_AXES[option.id]
              );
              const isAvailableToAdd = !isSelected && !axisRepresented;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => handleToggleTemplate(option.id)}
                  title={isAvailableToAdd ? `${option.name} -- combine with what's already selected` : option.name}
                  className={
                    "flex flex-col items-center justify-center gap-1 rounded-md border-2 bg-background " +
                    (isSelected
                      ? "border-accent"
                      : isAvailableToAdd
                        ? "border-dashed border-accent/50 bg-accent/5"
                        : "border-transparent")
                  }
                >
                  <TemplateIcon id={option.id} className="h-5 w-5 text-foreground" />
                  <span className="text-[10px] text-foreground">{option.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Panel 3 (~55%) -- position the clip rectangle on the actual
            photo (left) alongside the animated preview (right), then the
            duration control below both. */}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex min-h-0 flex-1 gap-2">
            <div className="flex min-h-0 flex-1 flex-col gap-1">
              <p className="text-[11px] text-muted">Position the clip rectangle</p>
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-black">
                {selectedAsset ? (
                  <div
                    className="relative mx-auto h-full max-w-full overflow-hidden"
                    style={loadedImage ? { aspectRatio: `${loadedImage.naturalWidth} / ${loadedImage.naturalHeight}` } : undefined}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL, not a Next-optimizable static asset */}
                    <img src={selectedAsset.url} alt={selectedAsset.filename} className="absolute inset-0 h-full w-full object-cover" />
                    {photoCropRect && (
                      <CropRectOverlay cropRect={photoCropRect} onChange={setPhotoCropRect} onCommit={setPhotoCropRect} />
                    )}
                  </div>
                ) : (
                  <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                    Choose a photo above
                  </p>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1">
              <p className="text-[11px] text-muted">Preview</p>
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-black">
                {selectedAsset ? (
                  <canvas
                    ref={canvasRef}
                    width={PREVIEW_CANVAS_WIDTH}
                    height={PREVIEW_CANVAS_HEIGHT}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                    Choose a photo above to preview its animation
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setDurationSeconds((d) => clamp(d - DURATION_STEP_SECONDS, MIN_IMAGE_CLIP_DURATION_SECONDS, MAX_IMAGE_CLIP_DURATION_SECONDS))}
              className="h-6 w-6 shrink-0 rounded-md border border-border text-sm text-foreground hover:bg-background"
              aria-label="Shorten duration"
            >
              −
            </button>

            <div ref={trackRef} className="relative h-2 flex-1 rounded-full bg-neutral-800">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-accent"
                style={{ width: `${durationFraction * 100}%` }}
              />
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

          <div className="mt-1 flex items-center gap-2">
            {editing && onDelete && (
              <button type="button" onClick={onDelete} className="text-xs text-red-600 hover:underline">
                Remove Cutaway
              </button>
            )}
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border py-1.5 px-3 text-sm font-medium text-foreground hover:bg-background"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!selectedAsset || !photoCropRect}
                onClick={() => selectedAsset && photoCropRect && onAdd(selectedAsset.id, durationSeconds, templateIds, photoCropRect)}
                className="rounded-md bg-accent py-1.5 px-3 text-sm font-medium text-accent-foreground disabled:opacity-50"
              >
                {editing ? "Save changes" : "Add cutaway"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
