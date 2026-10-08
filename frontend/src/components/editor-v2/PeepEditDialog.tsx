"use client";

/**
 * Reopens the peep editor on a peep that's already on the timeline (double-click
 * it in the preview, or right-click its timeline bar -> "Edit peep"). It is the
 * same PeepsTab (or, for a figure made in the Real poses tab, PeepsPlusTab) used to create one, opened on the overlay's stored settings;
 * applying redraws the artwork, uploads it as a new image and swaps it into the
 * overlay, keeping its timing, position and effects. Also opened from the asset
 * gallery on a peep asset, where applying just adds the result as a new peep.
 */
import { useState } from "react";
import { uploadAsset, type Asset } from "@/lib/api";
import { PeepsPlusTab, isPackPeep } from "./PeepsPlusTab";
import { PeepsTab } from "./PeepsTab";

export function PeepEditDialog({
  projectId,
  initialPeep,
  onApply,
  onClose,
  title = "Edit peep",
  submitLabel = "Update peep",
}: {
  projectId: string;
  initialPeep: Record<string, unknown>;
  onApply: (asset: Asset, aspect: number, peep: Record<string, unknown>) => void;
  onClose: () => void;
  title?: string;
  submitLabel?: string;
}) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleApply(file: File, _key: string, aspect: number, peep?: object) {
    // Editing always supplies the figure's settings; only a ready-made figure (not editable) lacks them.
    if (applying || !peep) return;
    setApplying(true);
    setError(null);
    uploadAsset(projectId, file, { ...peep })
      .then((asset) => {
        onApply(asset, aspect, { ...peep });
        onClose();
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not update this peep");
        setApplying(false);
      });
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="flex h-[70vh] w-full max-w-2xl flex-col rounded-lg border border-accent bg-surface p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
        {isPackPeep(initialPeep) ? (
          <PeepsPlusTab placingKey={applying ? "peep" : null} onPlace={handleApply} initialPeep={initialPeep} submitLabel={submitLabel} />
        ) : (
          <PeepsTab placingKey={applying ? "peep" : null} onPlace={handleApply} initialPeep={initialPeep} submitLabel={submitLabel} />
        )}
      </div>
    </div>
  );
}
