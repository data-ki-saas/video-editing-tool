"use client";

/**
 * "Browse the asset library" popup, opened by AssetGallery's "+ Library"
 * button (replacing "+ Record") -- a global, cross-user catalog of assets
 * other creators have opted to share, distinct from "+ Stock" (a third-party
 * Pexels/Freesound search, StockMediaDialog.tsx) even though the shape of
 * this dialog deliberately mirrors it: browse by kind, preview before
 * committing (photo needs none, video/audio get a real player), "Add".
 *
 * Only the "Avatars" tab ever returns results today -- promoting an avatar
 * (see PromoteAvatarDialog.tsx, reachable from the /avatars page) is the
 * only promote path implemented so far; Videos/Images/Audio are wired up
 * ready for a future promote flow but show an empty state until one exists.
 *
 * "Add" behaves differently for avatars than for every other kind: an
 * avatar isn't a project `Asset` at all (see lib/api.ts's Asset type), so
 * importing one adds it to the CALLER's own "My avatars" list instead
 * (onImportedAvatar) -- there's nothing to select in this project afterward,
 * just a confirmation. Video/image/audio instead land in this project's own
 * asset gallery (onImported), same as an upload or a "+ Stock" import.
 */
import { useEffect, useState } from "react";
import { importLibraryAvatarToMine } from "@/lib/video/avatar/generatedLibrary";
import { importLibraryAssetToProject, listLibraryAssets, type Asset, type LibraryAssetSummary, type LibraryAssetType } from "@/lib/api";

const KIND_TABS: { id: LibraryAssetType; label: string }[] = [
  { id: "avatar", label: "Avatars" },
  { id: "video", label: "Videos" },
  { id: "image", label: "Images" },
  { id: "audio", label: "Audio" },
];

const EMPTY_TEXT: Record<LibraryAssetType, string> = {
  avatar: "No avatars have been shared to the library yet.",
  video: "No videos have been shared to the library yet.",
  image: "No images have been shared to the library yet.",
  audio: "No audio has been shared to the library yet.",
};

function AddButton({ isImporting, isImported, onImport }: { isImporting: boolean; isImported: boolean; onImport: () => void }) {
  return (
    <button
      type="button"
      onClick={onImport}
      disabled={isImporting || isImported}
      className="shrink-0 rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-accent-foreground disabled:opacity-50"
    >
      {isImported ? "Added" : isImporting ? "…" : "Add"}
    </button>
  );
}

/** Avatar/photo/video grid tile -- clicking the thumbnail previews (video
 * opens the nested player popup below; a photo's grid thumbnail already IS
 * the preview, same convention StockMediaDialog's ResultTile uses; an
 * avatar's thumbnail is its whole preview, nothing further to check). */
function LibraryAssetTile({
  asset,
  isImporting,
  isImported,
  onPreview,
  onImport,
}: {
  asset: LibraryAssetSummary;
  isImporting: boolean;
  isImported: boolean;
  onPreview: () => void;
  onImport: () => void;
}) {
  const canPreview = asset.assetType === "video";
  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-border bg-background">
      <button
        type="button"
        onClick={canPreview ? onPreview : undefined}
        title={canPreview ? "Preview before adding" : asset.title}
        className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-neutral-900"
      >
        {asset.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a public R2 URL, not a Next-optimizable static asset
          <img src={asset.thumbnailUrl} alt={asset.title} className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-muted">No preview</span>
        )}
        {canPreview && <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] text-white">▶</span>}
      </button>
      <div className="flex flex-col gap-1 p-1.5">
        <span className="truncate text-xs font-medium text-foreground" title={asset.title}>
          {asset.title}
        </span>
        {asset.description && (
          <p className="line-clamp-2 text-[10px] text-muted" title={asset.description}>
            {asset.description}
          </p>
        )}
        <AddButton isImporting={isImporting} isImported={isImported} onImport={onImport} />
      </div>
    </div>
  );
}

/** Audio row -- a native `<audio controls>` sits directly in the row so it's
 * playable with no extra click, same reasoning as StockMediaDialog's
 * MusicResultRow. */
function LibraryAudioRow({
  asset,
  isImporting,
  isImported,
  onImport,
}: {
  asset: LibraryAssetSummary;
  isImporting: boolean;
  isImported: boolean;
  onImport: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-background p-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={asset.title}>
            {asset.title}
          </span>
        </div>
        {asset.mediaUrl && <audio controls src={asset.mediaUrl} className="mt-1 h-8 w-full" />}
        {asset.description && (
          <p className="mt-0.5 truncate text-[10px] text-muted" title={asset.description}>
            {asset.description}
          </p>
        )}
      </div>
      <AddButton isImporting={isImporting} isImported={isImported} onImport={onImport} />
    </div>
  );
}

/** The video-tile preview step -- a small nested modal playing the actual
 * file, with its own "Add" button, mirroring StockPreviewPopup exactly. */
function LibraryVideoPreviewPopup({
  asset,
  isImporting,
  isImported,
  onClose,
  onImport,
}: {
  asset: LibraryAssetSummary;
  isImporting: boolean;
  isImported: boolean;
  onClose: () => void;
  onImport: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${asset.title}`}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-semibold">{asset.title}</h3>
          <button type="button" onClick={onClose} aria-label="Close preview" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="flex items-center justify-center overflow-hidden rounded-md bg-black">
          {asset.mediaUrl && <video src={asset.mediaUrl} controls autoPlay className="max-h-[60vh] w-full" />}
        </div>

        {asset.description && <p className="mt-2 text-[11px] text-muted">{asset.description}</p>}

        <button
          type="button"
          onClick={onImport}
          disabled={isImporting || isImported}
          className="mt-3 w-full rounded-md bg-accent py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {isImported ? "Added" : isImporting ? "Adding…" : "Add to project"}
        </button>
      </div>
    </div>
  );
}

export function LibraryAssetDialog({
  projectId,
  onImported,
  onImportedAvatar,
  onImportingChange,
  onClose,
}: {
  projectId: string;
  // Video/image/audio -- lands in this project's own asset gallery.
  onImported: (asset: Asset) => void;
  // Avatar -- lands in the caller's own "My avatars" instead (see this
  // file's own module comment for why).
  onImportedAvatar: (name: string) => void;
  onImportingChange?: (isImporting: boolean) => void;
  onClose: () => void;
}) {
  const [activeKind, setActiveKind] = useState<LibraryAssetType>("avatar");
  // Keyed by kind rather than a single flat list, so switching tabs can't
  // ever show a stale kind's results while the next fetch is in flight, and
  // a previously-loaded tab keeps its results if revisited mid-dialog.
  const [assetsByKind, setAssetsByKind] = useState<Partial<Record<LibraryAssetType, LibraryAssetSummary[]>>>({});
  // The most recent kind whose fetch has SETTLED (success or failure) --
  // isLoading is derived from this rather than its own boolean state, so the
  // effect below never calls setState synchronously in its own body (only
  // from the async .then/.catch), per react-hooks' set-state-in-effect rule.
  const [settledKind, setSettledKind] = useState<LibraryAssetType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [previewAsset, setPreviewAsset] = useState<LibraryAssetSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    listLibraryAssets(activeKind)
      .then((results) => {
        if (cancelled) return;
        setAssetsByKind((prev) => ({ ...prev, [activeKind]: results }));
        setError(null);
        setSettledKind(activeKind);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load the library");
        setSettledKind(activeKind);
      });
    return () => {
      cancelled = true;
    };
  }, [activeKind]);

  const isLoading = settledKind !== activeKind;
  const assets = assetsByKind[activeKind] ?? [];

  function handleImport(asset: LibraryAssetSummary) {
    setImportingIds((prev) => new Set(prev).add(asset.id));
    onImportingChange?.(true);
    const importPromise =
      asset.assetType === "avatar"
        ? importLibraryAvatarToMine(asset.id).then((summary) => onImportedAvatar(summary.name))
        : importLibraryAssetToProject(asset.id, projectId).then(onImported);

    importPromise
      .then(() => setImportedIds((prev) => new Set(prev).add(asset.id)))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to add this item"))
      .finally(() => {
        setImportingIds((prev) => {
          const next = new Set(prev);
          next.delete(asset.id);
          return next;
        });
        onImportingChange?.(false);
      });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Browse the asset library"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[80vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Asset library</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-2 text-[11px] text-muted">
          Shared by other creators for anyone to use -- avatars added here go to your own &quot;My avatars&quot;, everything else
          goes straight into this project.
        </p>

        <div className="mb-3 flex gap-1">
          {KIND_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveKind(tab.id)}
              className={
                "rounded-md px-3 py-1 text-xs font-medium " +
                (activeKind === tab.id ? "bg-accent text-accent-foreground" : "text-muted hover:bg-background")
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="text-center text-xs text-muted">Loading…</p>
          ) : assets.length === 0 ? (
            <p className="text-center text-xs text-muted">{EMPTY_TEXT[activeKind]}</p>
          ) : activeKind === "audio" ? (
            <div className="flex flex-col gap-2">
              {assets.map((asset) => (
                <LibraryAudioRow
                  key={asset.id}
                  asset={asset}
                  isImporting={importingIds.has(asset.id)}
                  isImported={importedIds.has(asset.id)}
                  onImport={() => handleImport(asset)}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {assets.map((asset) => (
                <LibraryAssetTile
                  key={asset.id}
                  asset={asset}
                  isImporting={importingIds.has(asset.id)}
                  isImported={importedIds.has(asset.id)}
                  onPreview={() => setPreviewAsset(asset)}
                  onImport={() => handleImport(asset)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {previewAsset && (
        <LibraryVideoPreviewPopup
          asset={previewAsset}
          isImporting={importingIds.has(previewAsset.id)}
          isImported={importedIds.has(previewAsset.id)}
          onClose={() => setPreviewAsset(null)}
          onImport={() => handleImport(previewAsset)}
        />
      )}
    </div>
  );
}
