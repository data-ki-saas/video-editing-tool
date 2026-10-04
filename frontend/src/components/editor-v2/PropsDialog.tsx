"use client";

/**
 * "Props" tab's popup -- a shelf of ready-made, see-through artwork (a car, a
 * coffee cup, a post box, a rocket launcher...) the creator can drop onto
 * their footage so it looks like it belongs in the scene.
 *
 * The artwork is just the shared asset library's `image` entries tagged
 * category "props" (see scripts/seed_free_library.py), so nothing here is a
 * new kind of data: picking one imports it into this project's own assets
 * (the same import-to-project path LibraryAssetDialog's Images tab uses) and
 * then places it as an ordinary image overlay at the playhead. That is what
 * gives every prop its own timeline row -- each Picture-in-Picture image
 * overlay already gets one (ImageOverlayTrack.tsx) -- and means it can be
 * dragged, resized, filtered, switched to 3D etc. exactly like any photo.
 *
 * One click does the whole thing (no select-then-confirm step, unlike
 * ImageOverlayPickerDialog): a prop is cheap to delete, and this app's
 * driving vision favors direct manipulation over confirmation dialogs.
 */
import { useEffect, useState } from "react";
import { importLibraryAssetToProject, listLibraryAssets, type Asset, type LibraryAssetSummary } from "@/lib/api";

// A light checkerboard, so a prop's transparent areas read as "see-through"
// rather than as a flat dark tile.
const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundColor: "#e5e5e5",
  backgroundImage:
    "linear-gradient(45deg, #cfcfcf 25%, transparent 25%, transparent 75%, #cfcfcf 75%), linear-gradient(45deg, #cfcfcf 25%, transparent 25%, transparent 75%, #cfcfcf 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
};

export function PropsDialog({
  projectId,
  onImported,
  onPlace,
  onImportingChange,
  onClose,
}: {
  projectId: string;
  // The imported file lands in this project's asset gallery first...
  onImported: (asset: Asset) => void;
  // ...then is placed on the timeline at the playhead (ThreePaneEditor's
  // handleAddImageOverlay).
  onPlace: (asset: Asset) => void;
  onImportingChange?: (isImporting: boolean) => void;
  onClose: () => void;
}) {
  const [props, setProps] = useState<LibraryAssetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placingId, setPlacingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listLibraryAssets("image", "props")
      .then((results) => {
        if (!cancelled) setProps(results);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load props");
        setProps([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handlePlace(prop: LibraryAssetSummary) {
    if (placingId) return;
    setPlacingId(prop.id);
    setError(null);
    onImportingChange?.(true);
    importLibraryAssetToProject(prop.id, projectId)
      .then((asset) => {
        onImported(asset);
        onPlace(asset);
        onClose();
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Couldn't add this prop");
        setPlacingId(null);
      })
      .finally(() => onImportingChange?.(false));
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Props" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="flex h-[70vh] w-full max-w-2xl flex-col rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Props -- drop something into your scene</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-3 text-[11px] text-muted">
          Click a prop to place it at the playhead on its own timeline row. Then drag it where it belongs, resize it, and slide
          its ends to choose how long it stays.
        </p>

        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

        <div className="flex-1 overflow-y-auto">
          {props === null ? (
            <p className="text-center text-xs text-muted">Loading…</p>
          ) : props.length === 0 ? (
            <p className="text-center text-xs text-muted">No props are available yet.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {props.map((prop) => (
                <button
                  key={prop.id}
                  type="button"
                  onClick={() => handlePlace(prop)}
                  disabled={placingId !== null}
                  title={prop.description ?? prop.title}
                  className="flex flex-col overflow-hidden rounded-md border border-border bg-background text-left hover:border-accent disabled:opacity-60"
                >
                  <span className="flex aspect-square w-full items-center justify-center p-2" style={CHECKERBOARD_STYLE}>
                    {prop.thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element -- a public R2 URL, not a Next-optimizable static asset
                      <img src={prop.thumbnailUrl} alt={prop.title} className="max-h-full max-w-full object-contain" />
                    )}
                  </span>
                  <span className="truncate px-1.5 py-1 text-xs font-medium text-foreground">
                    {placingId === prop.id ? "Adding…" : prop.title}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
