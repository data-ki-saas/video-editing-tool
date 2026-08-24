"use client";

/**
 * Popup for picking the reel's clip-rectangle aspect ratio -- opened from
 * UserActions' vertical "Clip" tab (mirrors Text/Auto-Caption/Image, which
 * all open a modal rather than expanding inline, unlike the old always-
 * expanded "Clip rectangle" panel this replaces). Unlike those three
 * dialogs there's nothing to position or type: picking a ratio is a single
 * click that applies immediately and closes the dialog, matching the old
 * inline picker's own one-click-applies behavior -- hovering (or
 * keyboard-focusing) an option first previews it against the real current
 * frame on the left, via the same max-coverage crop math
 * (computeMaxCoverageCropFraction) ThreePaneEditor's handleSelectClipRect
 * uses to actually apply a choice, so the preview is exactly what
 * selecting it would produce.
 */
import { useState } from "react";
import { CLIP_RECT_OPTIONS, ClipRectIcon } from "./ClipRectIcon";
import { CropRectOverlay } from "./CropRectOverlay";
import { computeMaxCoverageCropFraction } from "@/lib/video/video_math";

export function ClipRectangleDialog({
  selectedClipRectId,
  onSelect,
  onClose,
  previewFrameUrl,
  frameAspectRatio,
}: {
  selectedClipRectId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  previewFrameUrl: string | null;
  frameAspectRatio: number | null;
}) {
  const [previewId, setPreviewId] = useState(selectedClipRectId ?? CLIP_RECT_OPTIONS[0].id);
  const previewOption = CLIP_RECT_OPTIONS.find((option) => option.id === previewId) ?? CLIP_RECT_OPTIONS[0];
  const targetRatio = previewOption.widthRatio / previewOption.heightRatio;
  const previewRect = computeMaxCoverageCropFraction(frameAspectRatio ?? targetRatio, targetRatio);

  function handleSelect(id: string) {
    onSelect(id);
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Clip rectangle"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Clip rectangle</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs text-muted">
          Picking a ratio applies it immediately and resets any zoom/pan on the clip -- hover an option to preview it
          first.
        </p>

        <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
          {/* Left half: the real frame, with the hovered/selected ratio's
              crop drawn to scale on top -- read-only, no drag handles. */}
          <div className="flex flex-col gap-1.5 sm:w-1/2">
            <div
              className="relative w-full overflow-hidden rounded-md bg-black"
              style={frameAspectRatio ? { aspectRatio: `${frameAspectRatio}` } : { minHeight: "12rem" }}
            >
              {previewFrameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset
                <img src={previewFrameUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : (
                <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                  No frame preview yet -- add a video first
                </p>
              )}
              <CropRectOverlay cropRect={previewRect} />
            </div>
            <p className="text-[11px] text-muted">
              {previewOption.name} ({previewOption.ratioLabel})
            </p>
          </div>

          {/* Right half: the ratio gallery. */}
          <div className="min-h-0 flex-1 overflow-y-auto sm:w-1/2">
            <div className="grid grid-cols-3 gap-2">
              {CLIP_RECT_OPTIONS.map((option) => {
                const isSelected = option.id === selectedClipRectId;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onMouseEnter={() => setPreviewId(option.id)}
                    onFocus={() => setPreviewId(option.id)}
                    onClick={() => handleSelect(option.id)}
                    title={`${option.name} -- ${option.ratioLabel}`}
                    className={
                      "flex flex-col items-center justify-center gap-1 rounded-md border-2 p-2 " +
                      (isSelected ? "border-accent bg-accent/10" : "border-transparent hover:bg-background")
                    }
                  >
                    <ClipRectIcon option={option} />
                    <span className="text-center text-[11px] text-foreground">{option.ratioLabel}</span>
                    <span className="text-center text-[10px] text-muted">{option.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
