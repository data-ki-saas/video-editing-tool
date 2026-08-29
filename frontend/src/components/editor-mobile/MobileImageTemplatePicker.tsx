"use client";

/**
 * Mobile's Ken Burns motion picker for an image sequence clip -- the
 * touch-friendly substitute for CutawayDialog.tsx's own image flow, which
 * needs a crop-rect DRAG to position the photo (poor touch fit -- see the
 * mobile quick-create plan). This always uses the photo's own max-coverage
 * crop for the project's current clip-rectangle ratio
 * (computeMaxCoverageCropFraction -- the same default CutawayDialog itself
 * seeds a fresh cutaway with, before any manual repositioning) rather than
 * exposing a drag handle for it.
 *
 * The animated preview loop reuses buildKenBurnsEffect + computeEffectiveCropRect
 * verbatim -- the exact math the real committed clip will use once saved
 * (transformations.ts's applyAddImageSequenceClip/applyEditImageSequenceClip
 * via MobileEditor), same "preview can't drift from what's committed"
 * property CutawayDialog's own preview has.
 */
import { useEffect, useRef, useState } from "react";
import type { Asset } from "@/lib/api";
import { computeContainRect, computeEffectiveCropRect, computeMaxCoverageCropFraction, FULL_FRAME_CROP_RECT, type CropRect } from "@/lib/video/video_math";
import { IMAGE_TEMPLATE_AXES, IMAGE_TEMPLATE_OPTIONS, buildKenBurnsEffect, type ImageTemplateId } from "@/lib/video/imageTemplates";
import {
  DEFAULT_IMAGE_CLIP_DURATION_SECONDS,
  MIN_IMAGE_CLIP_DURATION_SECONDS,
  MAX_IMAGE_CLIP_DURATION_SECONDS,
} from "@/lib/video/transformations";
import { loadCrossOriginImage } from "@/lib/crossOriginImage";

const PREVIEW_CANVAS_SIZE_PX = 480;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function MobileImageTemplatePicker({
  asset,
  clipRectAspectRatio,
  editing,
  onSave,
  onClose,
}: {
  asset: Asset;
  clipRectAspectRatio: number;
  /** Non-null when reopened to edit an existing image clip's motion --
   * pre-populates the template picks/duration (position is never re-editable
   * here, see this file's own module comment). */
  editing?: { templateIds: string[]; durationSeconds: number } | null;
  onSave: (durationSeconds: number, templateIds: string[], cropRect: CropRect) => void;
  onClose: () => void;
}) {
  const [templateIds, setTemplateIds] = useState<ImageTemplateId[]>(
    (editing?.templateIds as ImageTemplateId[] | undefined) ?? [IMAGE_TEMPLATE_OPTIONS[0].id]
  );
  const [durationSeconds, setDurationSeconds] = useState(editing?.durationSeconds ?? DEFAULT_IMAGE_CLIP_DURATION_SECONDS);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);

  // Via loadCrossOriginImage, not a plain new Image() -- see that
  // function's own module comment for why a plain no-cors load of this
  // exact URL can poison the browser's cache against CanvasPlayer's later
  // CORS-mode fetch of it for the live preview.
  useEffect(() => {
    let cancelled = false;
    let ownBlobUrl: string | null = null;
    loadCrossOriginImage(asset.url)
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
  }, [asset]);

  useEffect(() => {
    if (!loadedImage) return;
    const photoAspectRatio = loadedImage.naturalWidth / loadedImage.naturalHeight;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change, same pattern as CutawayDialog's own equivalent effect
    setCropRect(computeMaxCoverageCropFraction(photoAspectRatio, clipRectAspectRatio));
  }, [loadedImage, clipRectAspectRatio]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !loadedImage || !cropRect) return;

    const zoomEffect = buildKenBurnsEffect(templateIds, cropRect, 0, durationSeconds);
    let rafId: number;
    let startTimestamp: number | null = null;

    function draw(timestamp: number) {
      if (startTimestamp === null) startTimestamp = timestamp;
      const elapsedRaw = ((timestamp - (startTimestamp ?? 0)) / 1000) % durationSeconds;
      // Nudged off the exact boundaries -- computeEffectiveCropRect's
      // active-effect check is strictly-between, so t=0 exactly would read
      // as "no effect active" and show the un-animated base rect once per loop.
      const elapsed = clamp(elapsedRaw, 0.001, durationSeconds - 0.001);
      const crop = computeEffectiveCropRect(cropRect ?? FULL_FRAME_CROP_RECT, [zoomEffect], elapsed);

      const img = loadedImage!;
      const sx = crop.x * img.naturalWidth;
      const sy = crop.y * img.naturalHeight;
      const sw = crop.width * img.naturalWidth;
      const sh = crop.height * img.naturalHeight;
      const dest = computeContainRect(canvas!.width, canvas!.height, crop.width / crop.height);
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx!.drawImage(img, sx, sy, sw, sh, dest.x, dest.y, dest.width, dest.height);
      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [loadedImage, templateIds, durationSeconds, cropRect]);

  // One pick per axis (zoom / horizontal pan / vertical pan), freely
  // combinable across axes -- same toggle rule as CutawayDialog's own
  // handleToggleTemplate, kept in lockstep with it deliberately (both
  // ultimately feed the same buildKenBurnsEffect).
  function handleToggleTemplate(id: ImageTemplateId) {
    setTemplateIds((prev) => {
      const axis = IMAGE_TEMPLATE_AXES[id];
      const withoutSameAxis = prev.filter((existingId) => IMAGE_TEMPLATE_AXES[existingId] !== axis);
      const next = prev.includes(id) ? withoutSameAxis : [...withoutSameAxis, id];
      if (next.length === 0) return prev;
      return IMAGE_TEMPLATE_OPTIONS.filter((option) => next.includes(option.id)).map((option) => option.id);
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo motion"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full flex-col gap-3 overflow-y-auto rounded-t-lg bg-surface p-4 pb-5 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Photo motion</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="mx-auto aspect-square w-full max-w-[280px] overflow-hidden rounded-md bg-black">
          <canvas
            ref={canvasRef}
            width={PREVIEW_CANVAS_SIZE_PX}
            height={PREVIEW_CANVAS_SIZE_PX}
            className="h-full w-full object-contain"
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          {IMAGE_TEMPLATE_OPTIONS.map((option) => {
            const isSelected = templateIds.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => handleToggleTemplate(option.id)}
                className={
                  "rounded-md border-2 bg-background px-2 py-3 text-xs font-medium " +
                  (isSelected ? "border-accent text-foreground" : "border-transparent text-muted")
                }
              >
                {option.name}
              </button>
            );
          })}
        </div>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Duration: {durationSeconds.toFixed(1)}s
          <input
            type="range"
            min={MIN_IMAGE_CLIP_DURATION_SECONDS}
            max={MAX_IMAGE_CLIP_DURATION_SECONDS}
            step={0.5}
            value={durationSeconds}
            onChange={(e) => setDurationSeconds(Number(e.target.value))}
          />
        </label>

        <button
          type="button"
          disabled={!cropRect}
          onClick={() => cropRect && onSave(durationSeconds, templateIds, cropRect)}
          className="w-full rounded-md bg-accent py-2.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {editing ? "Save changes" : "Add motion"}
        </button>
      </div>
    </div>
  );
}
