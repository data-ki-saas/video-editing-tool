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
import { useEffect, useMemo, useRef, useState } from "react";
import { deleteLibraryProp, importLibraryAssetToProject, importPng, listLibraryAssets, uploadAsset, uploadLibraryProp, type Asset, type LibraryAssetSummary, type PngSearchResult } from "@/lib/api";
import { loadImageAspectRatio } from "@/lib/image";
import { fitRectToImageAspect, type ImageOverlayPlacement } from "@/lib/video/transformations";
import { DEFAULT_OVERLAY_FRAMING, type OverlayFraming } from "@/lib/video/video_math";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { PeepsTab } from "./PeepsTab";
import { PngTab } from "./PngTab";
import { rasterizeSvgToPng, VectorsTab } from "./VectorsTab";

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
    // One scan pixel of margin each side: the downscaled scan can round the
    // bounds in by up to that much, which would shave the artwork's edge.
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(scanWidth - 1, maxX + 1);
    maxY = Math.min(scanHeight - 1, maxY + 1);
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

// A box matching the artwork's own shape (so the overlay's cover-fit never
// crops it), centered, in the frame's normalized coordinates. The pixel scan
// above can fail (e.g. a cross-origin fetch is blocked); loadImageAspectRatio
// is the fallback, since an <img> can still load the file and report its shape.
const propRect = fitRectToImageAspect;

type Tab = "props" | "icons" | "vectors" | "peeps" | "png";

const TAB_LABELS: Record<Tab, string> = { props: "Props", icons: "Icons", vectors: "Vectors", peeps: "Peeps", png: "PNG" };

// Google Material icons (src/lib/materialIcons.json, built by
// scripts/build-material-icons.mjs) load lazily, only once the Icons tab opens.
const ICON_RASTER_SIZE = 512;
const ICON_PAGE_SIZE = 150;
const ICON_COLOR_SWATCHES = ["#ffffff", "#000000", "#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];

function iconSvgMarkup(inner: string, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_RASTER_SIZE}" height="${ICON_RASTER_SIZE}" viewBox="0 0 24 24" fill="${color}">${inner}</svg>`;
}

/** Rasterizes the glyph, in the chosen colour, to a transparent PNG -- which
 * then travels the exact same upload -> image-overlay path as any prop, so it
 * renders identically in the preview and all export paths. */
function renderIconPng(name: string, inner: string, color: string): Promise<File> {
  return rasterizeSvgToPng(iconSvgMarkup(inner, color), `icon-${name}.png`);
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
  const [tab, setTab] = useState<Tab>("props");
  // Props are a shared catalog, so only admins can add to or prune it.
  const isAdmin = useIsAdmin() === true;
  const [uploadingProp, setUploadingProp] = useState(false);
  const propFileInput = useRef<HTMLInputElement>(null);
  const [icons, setIcons] = useState<Record<string, string> | null>(null);
  const [iconQuery, setIconQuery] = useState("");
  const [iconColor, setIconColor] = useState("#ffffff");
  const [iconLimit, setIconLimit] = useState(ICON_PAGE_SIZE);

  useEffect(() => {
    if (tab !== "icons" || icons) return;
    let cancelled = false;
    import("@/lib/materialIcons.json")
      .then((module) => {
        if (!cancelled) setIcons(module.default as Record<string, string>);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Failed to load icons");
        setIcons({});
      });
    return () => {
      cancelled = true;
    };
  }, [tab, icons]);

  const matchingIconNames = useMemo(() => {
    if (!icons) return [];
    const terms = iconQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return Object.keys(icons).filter((name) => terms.every((term) => name.includes(term)));
  }, [icons, iconQuery]);

  function handlePlaceIcon(name: string) {
    if (!icons) return;
    placeRasterized(name, renderIconPng(name, icons[name], iconColor));
  }

  // Shared by the Icons and Vectors tabs: upload the rasterized PNG, then
  // place it as an aspect-locked prop (square unless told otherwise).
  function placeRasterized(key: string, filePromise: Promise<File>, aspect = 1) {
    if (placingId) return;
    setPlacingId(key);
    setError(null);
    onImportingChange?.(true);
    filePromise
      .then((file) => uploadAsset(projectId, file))
      .then((asset) => {
        onImported(asset);
        onPlace(asset, { rect: propRect(aspect, frameAspectRatio ?? 9 / 16), lockAspect: true });
        onClose();
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not add this icon or vector");
        setPlacingId(null);
      })
      .finally(() => onImportingChange?.(false));
  }

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

  async function handleUploadProps(files: FileList | null) {
    if (!files || files.length === 0 || uploadingProp) return;
    setUploadingProp(true);
    setError(null);
    const added: LibraryAssetSummary[] = [];
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        added.push(await uploadLibraryProp(file, file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")));
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`);
      }
    }
    if (added.length > 0) setProps((previous) => [...added.reverse(), ...(previous ?? [])]);
    if (failures.length > 0) setError(failures.join("; "));
    setUploadingProp(false);
    if (propFileInput.current) propFileInput.current.value = "";
  }

  async function handleDeleteProp(prop: LibraryAssetSummary) {
    if (!window.confirm(`Delete "${prop.title}" for everyone? This can't be undone.`)) return;
    setError(null);
    try {
      await deleteLibraryProp(prop.id);
      setProps((previous) => (previous ?? []).filter((item) => item.id !== prop.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete this prop");
    }
  }

  // Shared by library props and PNG-search results: both arrive as a project
  // asset of see-through artwork, trimmed to its visible bounds and placed in
  // a box shaped like it.
  async function placeImportedAsset(asset: Asset, thumbnailUrl: string | null) {
    const artwork = (await measurePropArtwork(asset.url)) ?? (thumbnailUrl ? await measurePropArtwork(thumbnailUrl) : null);
    const frameAspect = frameAspectRatio ?? 9 / 16;
    const fallbackAspect = artwork ? null : ((await loadImageAspectRatio(asset.url)) ?? (await loadImageAspectRatio(thumbnailUrl ?? "")));
    onImported(asset);
    onPlace(
      asset,
      artwork
        ? { rect: propRect(artwork.aspect, frameAspect), framing: artwork.framing, lockAspect: true }
        : fallbackAspect
          ? { rect: propRect(fallbackAspect, frameAspect), lockAspect: true }
          : undefined
    );
    onClose();
  }

  function handlePlace(prop: LibraryAssetSummary) {
    if (placingId) return;
    setPlacingId(prop.id);
    setError(null);
    onImportingChange?.(true);
    importLibraryAssetToProject(prop.id, projectId)
      .then((asset) => placeImportedAsset(asset, prop.thumbnailUrl ?? null))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Couldn't add this prop");
        setPlacingId(null);
      })
      .finally(() => onImportingChange?.(false));
  }

  function handlePlacePng(result: PngSearchResult) {
    if (placingId) return;
    setPlacingId(result.id);
    setError(null);
    onImportingChange?.(true);
    importPng(projectId, result.id, result.title)
      .then((asset) => placeImportedAsset(asset, result.thumbnail_url))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Couldn't add this PNG");
        setPlacingId(null);
      })
      .finally(() => onImportingChange?.(false));
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Props" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="flex h-[70vh] w-full max-w-2xl flex-col rounded-lg border border-accent bg-surface p-4 shadow-lg">
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

        <div className="mb-3 flex gap-1 border-b border-border">
          {(["props", "icons", "vectors", "peeps", "png"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-1 text-xs font-medium ${
                tab === id ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {TAB_LABELS[id]}
            </button>
          ))}
        </div>

        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

        {tab === "png" ? (
          <PngTab placingKey={placingId} onPlace={handlePlacePng} />
        ) : tab === "peeps" ? (
          <PeepsTab placingKey={placingId} onPlace={(file, key, aspect) => placeRasterized(key, Promise.resolve(file), aspect)} />
        ) : tab === "vectors" ? (
          <VectorsTab placingKey={placingId} onPlace={(file, key) => placeRasterized(key, Promise.resolve(file))} />
        ) : tab === "icons" ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <input
                type="search"
                value={iconQuery}
                onChange={(e) => {
                  setIconQuery(e.target.value);
                  setIconLimit(ICON_PAGE_SIZE);
                }}
                placeholder="Search Google Material icons (e.g. star, heart, arrow)"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
              />
              <div className="flex items-center gap-1">
                {ICON_COLOR_SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    onClick={() => setIconColor(swatch)}
                    aria-label={`Colour ${swatch}`}
                    style={{ backgroundColor: swatch }}
                    className={`h-5 w-5 rounded-full border ${iconColor === swatch ? "ring-2 ring-accent ring-offset-1" : "border-border"}`}
                  />
                ))}
                <input
                  type="color"
                  value={iconColor}
                  onChange={(e) => setIconColor(e.target.value)}
                  aria-label="Custom colour"
                  className="h-6 w-6 cursor-pointer rounded border border-border bg-transparent p-0"
                />
              </div>
            </div>
            <p className="mb-2 text-[11px] text-muted">
              Pick a colour, then click an icon to place it like a prop -- drag it, resize it, slide its ends. To change its
              colour later, delete it and add it again.
            </p>
            <div className="flex-1 overflow-y-auto">
              {icons === null ? (
                <p className="text-center text-xs text-muted">Loading…</p>
              ) : matchingIconNames.length === 0 ? (
                <p className="text-center text-xs text-muted">No icons match.</p>
              ) : (
                <>
                  <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
                    {matchingIconNames.slice(0, iconLimit).map((name) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => handlePlaceIcon(name)}
                        disabled={placingId !== null}
                        title={name.replace(/_/g, " ")}
                        className="flex aspect-square items-center justify-center rounded-md border border-border p-2 hover:border-accent disabled:opacity-60"
                        style={CHECKERBOARD_STYLE}
                      >
                        {placingId === name ? (
                          <span className="text-[10px] text-black">…</span>
                        ) : (
                          <svg
                            viewBox="0 0 24 24"
                            fill={iconColor}
                            className="h-full w-full drop-shadow-[0_0_1px_rgba(0,0,0,0.6)]"
                            dangerouslySetInnerHTML={{ __html: icons[name] }}
                          />
                        )}
                      </button>
                    ))}
                  </div>
                  {matchingIconNames.length > iconLimit && (
                    <button
                      type="button"
                      onClick={() => setIconLimit((n) => n + ICON_PAGE_SIZE)}
                      className="mx-auto mt-3 block rounded-md border border-border px-3 py-1 text-xs text-muted hover:text-foreground"
                    >
                      Show more ({matchingIconNames.length - iconLimit} left)
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        ) : (
        <div className="flex-1 overflow-y-auto">
          {isAdmin && (
            <div className="mb-2 flex items-center gap-2">
              <input
                ref={propFileInput}
                type="file"
                accept="image/png,image/webp,image/gif"
                multiple
                className="hidden"
                onChange={(e) => void handleUploadProps(e.target.files)}
              />
              <button
                type="button"
                onClick={() => propFileInput.current?.click()}
                disabled={uploadingProp}
                className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-60"
              >
                {uploadingProp ? "Uploading…" : "+ Upload props"}
              </button>
              <span className="text-[10px] text-muted">Admin: transparent PNG cut-outs. Changes are shared with everyone.</span>
            </div>
          )}
          {props === null ? (
            <p className="text-center text-xs text-muted">Loading…</p>
          ) : props.length === 0 ? (
            <p className="text-center text-xs text-muted">No props are available yet.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {props.map((prop) => (
                <div key={prop.id} className="relative">
                {isAdmin && (
                  // Floats over the artwork's bottom-right corner (just above the title row).
                  <button
                    type="button"
                    onClick={() => void handleDeleteProp(prop)}
                    aria-label={`Delete ${prop.title}`}
                    title="Delete this prop for everyone"
                    className="absolute bottom-8 right-1 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-white shadow hover:bg-red-700"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handlePlace(prop)}
                  disabled={placingId !== null}
                  title={prop.description ?? prop.title}
                  className="flex w-full flex-col overflow-hidden rounded-md border border-border bg-background text-left hover:border-accent disabled:opacity-60"
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
                </div>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
