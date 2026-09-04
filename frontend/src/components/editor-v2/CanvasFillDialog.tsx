"use client";

/**
 * Popup for picking ONE cutaway's own "Canvas fill" -- how a clip whose own
 * aspect ratio doesn't match the project's canvas is shown: cropped to fill
 * (today's only behavior, see video_math.ts's computeMaxCoverageCropRect),
 * or letterboxed/pillarboxed with the full uncropped frame centered and the
 * empty bars filled by a blurred backdrop, a solid color, or a gradient.
 * Opened from that clip's own right-click "Canvas fill…" on CutawayTrack.tsx
 * (see ActionArea.tsx's canvasFillDialogCutaway), same one-click-applies
 * convention as FilterPresetDialog for Blur/Crop -- Solid Color/Gradient
 * apply live as their color picker(s) change instead, so a color can be
 * tweaked without reopening the dialog each time.
 *
 * `outputAspectRatio` is the CANVAS's own ratio (not this clip's native
 * one) -- the whole point of this dialog is showing how the clip's frame
 * sits inside that canvas, same aspect-ratio-locked preview box convention
 * as VideoOverlayFramingDialog/ImageOverlayFramingDialog.
 */
import { useState } from "react";
import {
  CANVAS_FILL_OPTIONS,
  DEFAULT_CANVAS_FILL_COLOR,
  DEFAULT_CANVAS_FILL_GRADIENT_COLOR,
  type CanvasFillMode,
} from "@/lib/video/canvasFillPresets";

export function CanvasFillDialog({
  selectedMode,
  selectedColor,
  selectedGradientColor,
  onSelect,
  onClose,
  previewFrameUrl,
  outputAspectRatio,
  scopeLabel,
}: {
  selectedMode: CanvasFillMode | null;
  selectedColor: string | undefined;
  selectedGradientColor: string | undefined;
  onSelect: (mode: CanvasFillMode, colors?: { color?: string; gradientColor?: string }) => void;
  onClose: () => void;
  previewFrameUrl: string | null;
  outputAspectRatio: number | null;
  /** e.g. "this cutaway" -- each cutaway has its own independent canvas
   * fill, so the subtitle names which one this dialog's choice applies to. */
  scopeLabel: string;
}) {
  const [previewMode, setPreviewMode] = useState<CanvasFillMode>(selectedMode ?? "crop");
  const [color, setColor] = useState(selectedColor ?? DEFAULT_CANVAS_FILL_COLOR);
  const [gradientColor, setGradientColor] = useState(selectedGradientColor ?? DEFAULT_CANVAS_FILL_GRADIENT_COLOR);

  function handleSelectMode(mode: CanvasFillMode) {
    setPreviewMode(mode);
    if (mode === "solid") {
      onSelect(mode, { color });
      return;
    }
    if (mode === "gradient") {
      onSelect(mode, { color, gradientColor });
      return;
    }
    // Blur/Crop -- nothing further to configure, apply and close (same
    // one-click-applies-and-closes convention as FilterPresetDialog).
    onSelect(mode);
    onClose();
  }

  function handleColorChange(next: string) {
    setColor(next);
    onSelect(previewMode, { color: next, gradientColor });
  }

  function handleGradientColorChange(next: string) {
    setGradientColor(next);
    onSelect(previewMode, { color, gradientColor: next });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Canvas fill"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Canvas fill</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs text-muted">
          Applies to {scopeLabel} -- fills the canvas around a mismatched clip instead of cropping it.
        </p>

        <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
          {/* Left half: the real frame, shown the way this mode would render it. */}
          <div className="flex flex-col gap-1.5 sm:w-1/2">
            <div
              className="relative w-full overflow-hidden rounded-md bg-black"
              style={{
                aspectRatio: outputAspectRatio && outputAspectRatio > 0 ? `${outputAspectRatio}` : "9 / 16",
              }}
            >
              {previewFrameUrl ? (
                <>
                  {previewMode === "blur" && (
                    // eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset
                    <img
                      src={previewFrameUrl}
                      alt=""
                      className="absolute inset-0 h-full w-full scale-110 object-cover"
                      style={{ filter: "blur(16px)" }}
                    />
                  )}
                  {previewMode === "solid" && <div className="absolute inset-0" style={{ background: color }} />}
                  {previewMode === "gradient" && (
                    <div
                      className="absolute inset-0"
                      style={{ background: `linear-gradient(to bottom, ${color}, ${gradientColor})` }}
                    />
                  )}
                  {/* eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset */}
                  <img
                    src={previewFrameUrl}
                    alt=""
                    className="absolute inset-0 h-full w-full"
                    style={{ objectFit: previewMode === "crop" ? "cover" : "contain" }}
                  />
                </>
              ) : (
                <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                  No frame preview yet -- add a video first
                </p>
              )}
            </div>
            <p className="text-[11px] text-muted">{CANVAS_FILL_OPTIONS.find((o) => o.id === previewMode)?.name}</p>
          </div>

          {/* Right half: the mode gallery, plus color picker(s) when relevant. */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto sm:w-1/2">
            <div className="grid grid-cols-2 gap-2">
              {CANVAS_FILL_OPTIONS.map((option) => {
                const isSelected = option.id === (selectedMode ?? "crop");
                return (
                  <button
                    key={option.id}
                    type="button"
                    onMouseEnter={() => setPreviewMode(option.id)}
                    onFocus={() => setPreviewMode(option.id)}
                    onClick={() => handleSelectMode(option.id)}
                    title={option.name}
                    className={
                      "flex flex-col items-center justify-center gap-1 rounded-md border-2 p-2 " +
                      (isSelected ? "border-accent bg-accent/10" : "border-transparent hover:bg-background")
                    }
                  >
                    <span className="text-center text-[11px] text-foreground">{option.name}</span>
                  </button>
                );
              })}
            </div>

            {previewMode === "solid" && (
              <label className="flex items-center gap-2 text-xs text-muted">
                Color
                <input
                  type="color"
                  value={color}
                  onChange={(e) => handleColorChange(e.target.value)}
                  className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
                />
              </label>
            )}
            {previewMode === "gradient" && (
              <div className="flex items-center gap-4 text-xs text-muted">
                <label className="flex items-center gap-2">
                  Top
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => handleColorChange(e.target.value)}
                    className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
                  />
                </label>
                <label className="flex items-center gap-2">
                  Bottom
                  <input
                    type="color"
                    value={gradientColor}
                    onChange={(e) => handleGradientColorChange(e.target.value)}
                    className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
