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
import type { ImageOverlayPlacement } from "@/lib/video/transformations";
import { DEFAULT_OVERLAY_FRAMING, type OverlayFraming } from "@/lib/video/video_math";

// A freshly-placed prop takes up to this share of the frame's width/height,
// whichever its own shape hits first.
const PROP_MAX_FRACTION = 0.5;

const ALPHA_VISIBLE_THRESHOLD = 16;
const ALPHA_SCAN_MAX_EDGE = 256;

interface PropArtwork {
  // Aspect ratio (width/height) of the visible artwork alone.
  aspect: number;
  // Pan/zoom that crops the overlay's cover-fit to just that artwork.
  framing: OverlayFraming;
}

/** The artwork's visible (non-transparent) bounds. Library props are often
 * padded with empty margin, which would otherwise leave dead space the box
 * can't shed -- e.g. a car that can never be dragged down to touch the
 * frame's bottom edge. Returns null when the file can't be read. */
async function measurePropArtwork(url: string): Promise<PropArtwork | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    const { width, height } = bitmap;
    if (width <= 0 || height <= 0) return null;
    const scale = Math.min(1, ALPHA_SCAN_MAX_EDGE / Math.max(width, height));
    const scanWidth = Math.max(1, Math.round(width * scale));
    const scanHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = scanWidth;
    canvas.height = scanHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, scanWidth, scanHeight);
    const { data } = ctx.getImageData(0, 0, scanWidth, scanHeight);
    let minX = scanWidth, minY = scanHeight, maxX = -1, maxY = -1;
    for (let y = 0; y < scanHeight; y++) {
      for (let x = 0; x < scanWidth; x++) {
        if (data[(y * scanWidth + x) * 4 + 3] > ALPHA_VISIBLE_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    // Back to source pixels.
    const bx = (minX / scanWidth) * width;
    const by = (minY / scanHeight) * height;
    const bw = ((maxX + 1 - minX) / scanWidth) * width;
    const bh = ((maxY + 1 - minY) / scanHeight) * height;
    const aspect = bw / bh;
    // Same cover-fit math as computeCoverFitSourceRect, solved for the window
    // that is exactly the artwork's bounds.
    const sourceAspect = width / height;
    const coverWidth = sourceAspect > aspect ? height * aspect : width;
    return {
      aspect,
      framing: {
        ...DEFAULT_OVERLAY_FRAMING,
        zoom: coverWidth / bw,
        panX: width - bw > 0.5 ? bx / (width - bw) : 0.5,
        panY: height - bh > 0.5 ? by / (height - bh) : 0.5,
      },
    };
  } catch {
    return null;
  }
}

/** A box matching the artwork's own shape (so the overlay's cover-fit never
 * crops it), centered, in the frame's normalized coordinates. */
function propRect(imageAspect: number, frameAspect: number): ImageOverlayPlacement["rect"] {
  // Normalized height/width that renders as imageAspect on a frameAspect frame.
  const heightPerWidth = frameAspect / imageAspect;
  let width = PROP_MAX_FRACTION;
  let height = width * heightPerWidth;
  if (height > PROP_MAX_FRACTION) {
    height = PROP_MAX_FRACTION;
    width = height / heightPerWidth;
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

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
  frameAspectRatio,
  onImported,
  onPlace,
  onImportingChange,
  onClose,
}: {
  projectId: string;
  // The video frame's width/height, to size a prop's box to its own shape.
  frameAspectRatio: number | null;
  // The imported file lands in this project's asset gallery first...
  onImported: (asset: Asset) => void;
  // ...then is placed on the timeline at the playhead (ThreePaneEditor's
  // handleAddImageOverlay), in a box shaped like the artwork so it isn't cropped.
  onPlace: (asset: Asset, placement?: ImageOverlayPlacement) => void;
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
      .then(async (asset) => {
        const artwork = (await measurePropArtwork(asset.url)) ?? (prop.thumbnailUrl ? await measurePropArtwork(prop.thumbnailUrl) : null);
        onImported(asset);
        onPlace(
          asset,
          artwork ? { rect: propRect(artwork.aspect, frameAspectRatio ?? 9 / 16), framing: artwork.framing, lockAspect: true } : undefined
        );
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
