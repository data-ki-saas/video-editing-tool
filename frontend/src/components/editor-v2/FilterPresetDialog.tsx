"use client";

/**
 * Popup for picking ONE cutaway or overlay's own color filter -- opened from
 * that clip's own right-click "Filter" on CutawayTrack.tsx/
 * ImageOverlayTrack.tsx/VideoOverlayTrack.tsx (see ActionArea.tsx's
 * filterDialogCutawayEntry/filterDialogVideoOverlay/filterDialogImageOverlay
 * for which target is currently open), same one-click-applies-and-closes
 * convention as ClipRectangleDialog (its own module comment has the full
 * rationale). Hovering/focusing a swatch previews it against the real
 * current frame on the left via a plain CSS `filter` style on the same
 * <img>, the identical approximation CanvasPlayer's live preview applies via
 * `ctx.filter` (see lib/video/filterPresets.ts's own module comment for why
 * this is an approximation of Creatomate's real colorFilter/colorFilterValue/
 * colorOverlay combination, not a literal render of it).
 */
import { useState } from "react";
import { FILTER_PRESET_OPTIONS, type FilterPresetId } from "@/lib/video/filterPresets";

export function FilterPresetDialog({
  selectedFilterId,
  onSelect,
  onClose,
  previewFrameUrl,
  frameAspectRatio,
  scopeLabel,
}: {
  selectedFilterId: FilterPresetId | null;
  onSelect: (id: FilterPresetId) => void;
  onClose: () => void;
  previewFrameUrl: string | null;
  frameAspectRatio: number | null;
  /** e.g. "this cutaway" / "this overlay" -- each cutaway/overlay has its
   * own independent filter now, so the subtitle names which one this
   * dialog's choice will apply to. */
  scopeLabel: string;
}) {
  const [previewId, setPreviewId] = useState<FilterPresetId>(selectedFilterId ?? "none");
  const previewOption = FILTER_PRESET_OPTIONS.find((option) => option.id === previewId) ?? FILTER_PRESET_OPTIONS[0];

  function handleSelect(id: FilterPresetId) {
    onSelect(id);
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Filter"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Filter</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs text-muted">
          Applies to {scopeLabel} -- hover a swatch to preview it first.
        </p>

        <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
          {/* Left half: the real frame, with the hovered/selected filter applied. */}
          <div className="flex flex-col gap-1.5 sm:w-1/2">
            <div
              className="relative w-full overflow-hidden rounded-md bg-black"
              style={frameAspectRatio ? { aspectRatio: `${frameAspectRatio}` } : { minHeight: "12rem" }}
            >
              {previewFrameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset
                <img
                  src={previewFrameUrl}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                  style={{ filter: previewOption.cssFilter }}
                />
              ) : (
                <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                  No frame preview yet -- add a video first
                </p>
              )}
            </div>
            <p className="text-[11px] text-muted">{previewOption.name}</p>
          </div>

          {/* Right half: the filter gallery. */}
          <div className="min-h-0 flex-1 overflow-y-auto sm:w-1/2">
            <div className="grid grid-cols-3 gap-2">
              {FILTER_PRESET_OPTIONS.map((option) => {
                const isSelected = option.id === (selectedFilterId ?? "none");
                return (
                  <button
                    key={option.id}
                    type="button"
                    onMouseEnter={() => setPreviewId(option.id)}
                    onFocus={() => setPreviewId(option.id)}
                    onClick={() => handleSelect(option.id)}
                    title={option.name}
                    className={
                      "flex flex-col items-center justify-center gap-1 rounded-md border-2 p-2 " +
                      (isSelected ? "border-accent bg-accent/10" : "border-transparent hover:bg-background")
                    }
                  >
                    <div className="h-10 w-10 overflow-hidden rounded-md bg-neutral-800">
                      {previewFrameUrl && (
                        // eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset
                        <img
                          src={previewFrameUrl}
                          alt=""
                          className="h-full w-full object-cover"
                          style={{ filter: option.cssFilter }}
                        />
                      )}
                    </div>
                    <span className="text-center text-[11px] text-foreground">{option.name}</span>
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
