"use client";

/**
 * This project's uploaded assets, grouped into three kind-labeled columns
 * side by side -- Videos, Images, Music -- each independently vertically
 * scrollable, replacing the original single mixed-kind row (a music tile
 * is visually distinct enough on its own, but grouping by kind up front
 * makes each column scannable rather than needing to spot the odd tile out
 * of a mixed strip). "+ Asset" opens UploadDialog instead of a permanent drop target
 * taking up space; right-click offers Delete, plus two actions for video and
 * image assets, symmetric across both kinds -- "Cutaway" and "Overlay":
 *  - Video "Cutaway" appends it to the concatenated video sequence as-is
 *    (handleAddToSequence -- the first one is what starts rendering frames
 *    at all, every later one plays right after whatever's already there).
 *  - Image "Cutaway" opens CutawayDialog pre-selected to this photo, to pick
 *    its Ken Burns motion(s)/crop/duration before it's appended
 *    (onOpenCutawayDialogForAsset) -- unlike video, a photo needs that setup
 *    before it can become part of the base sequence.
 *  - "Overlay" (either kind) places it on its own rail at the current
 *    playhead with a switchable Full-Screen/Picture-in-Picture/Split Screen
 *    layout (handleAddVideoOverlay / handleAddImageOverlay -- see
 *    VideoOverlayTrack.tsx/ImageOverlayTrack.tsx).
 * For music, "Add" appends it to the background-music sequence
 * (handleAddToBackgroundSequence -- multiple appended tracks concatenate,
 * then loop as a whole across the video's duration). A small "+" badge
 * marks a tile as currently in use (referenced by an overlay, in the video
 * sequence, or in the background sequence), mirroring the selected-tile
 * border rather than being a separate concept. Thumbnails are a fixed
 * square, regardless of asset kind/aspect ratio.
 *
 * Music tiles also get a "Play"/"Pause" action -- plays right there in the
 * tile (a plain hidden <audio>, driven entirely by JS, not the browser's
 * native control bar) with a circular progress ring animated over the
 * music-note icon, rather than opening any kind of popup. Only one track
 * plays at a time; starting a second stops whichever was already playing.
 */
import { useEffect, useRef, useState } from "react";
import { deleteAsset, type Asset, type AssetKind } from "@/lib/api";
import { getVideoDuration } from "@/lib/video/video";
import { getAudioDuration } from "@/lib/video/audio";
import { useCrossOriginImageSrcMap } from "@/lib/useCrossOriginImageSrc";
import { ReelLoader } from "@/components/ReelLoader";
import { MusicNoteIcon } from "@/components/icons/UIIcons";
import { PauseIcon } from "./icons/PlayerIcons";
import { ContextMenu, useContextMenu } from "./ContextMenu";

// SVG circumference for the progress ring (r=16 in a 36x36 viewBox) --
// shared by the ring's own stroke-dasharray and its progress-driven offset.
const RING_RADIUS = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** m:ss, no leading zero on minutes -- e.g. 12.7s -> "0:13", 75s -> "1:15".
 * Rounds rather than truncates so a 59.6s clip reads "1:00", not "0:59". */
function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const wholeSeconds = rounded % 60;
  return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}`;
}

// Row order/labels for the three kind-grouped sections below -- "audio"
// assets are music to the user, so it's labeled that way here even though
// AssetKind (and the rest of this file) keeps calling it "audio".
const ASSET_SECTIONS: { kind: AssetKind; label: string; emptyText: string }[] = [
  { kind: "video", label: "Videos", emptyText: "No videos yet" },
  { kind: "image", label: "Images", emptyText: "No images yet" },
  { kind: "audio", label: "Music", emptyText: "No music yet" },
];

export function AssetGallery({
  assets,
  isLoading,
  selectedAssetId,
  onSelect,
  onAddAsset,
  onBrowseStock,
  onDeleted,
  onAddImageOverlay,
  onAddToSequence,
  onAddVideoOverlay,
  onAddToBackgroundSequence,
  onOpenCutawayDialogForAsset,
  usedAssetIds,
  videoThumbnailUrlByAssetId,
}: {
  assets: Asset[];
  // Distinguishes "still fetching the list" from "fetched, there really
  // are none" -- showing "No assets yet" during the former read as a bug
  // (assets that clearly exist appearing to not exist, briefly).
  isLoading: boolean;
  selectedAssetId: string | null;
  onSelect: (asset: Asset) => void;
  onAddAsset: () => void;
  onBrowseStock: () => void;
  onDeleted: (assetId: string) => void;
  onAddImageOverlay: (asset: Asset) => void;
  onAddToSequence: (asset: Asset) => void;
  onAddVideoOverlay: (asset: Asset) => void;
  onAddToBackgroundSequence: (asset: Asset) => void;
  onOpenCutawayDialogForAsset: (asset: Asset) => void;
  usedAssetIds: Set<string>;
  // assetId -> a single representative still frame, one per video asset --
  // lifted up to ThreePaneEditor (rather than generated locally here, as
  // this component used to) since VideoOverlayTrack.tsx also needs the
  // exact same thumbnails and lives in a sibling subtree, not a descendant
  // of this component.
  videoThumbnailUrlByAssetId: Record<string, string>;
}) {
  // Which tiles have a delete in flight -- deleteAsset() can take a moment
  // (Supabase row delete + R2 object cleanup server-side), so a tile stays
  // visible with a spinner over it rather than looking unresponsive to a
  // click that already registered. Same in-flight-ids-as-a-Set shape as
  // StockMediaDialog.tsx's importingIds.
  const [deletingAssetIds, setDeletingAssetIds] = useState<Set<string>>(new Set());
  const [playingAssetId, setPlayingAssetId] = useState<string | null>(null);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

  // Image thumbnails must never load asset.url via a plain <img> -- see
  // useCrossOriginImageSrcMap's own comment for why that can poison the
  // browser's cache against CanvasPlayer's later CORS-mode fetch of the
  // exact same URL for the live preview.
  const imageThumbnailSrcById = useCrossOriginImageSrcMap(
    assets.filter((asset) => asset.kind === "image").map((asset) => ({ id: asset.id, url: asset.url }))
  );

  // Each video/music tile's own real duration, painted as a small badge
  // (see the "0:12" pill in renderTile below) -- probed once per asset,
  // the first time it shows up here. Images have no duration to show.
  const [assetDurationSeconds, setAssetDurationSeconds] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    for (const asset of assets) {
      if (asset.kind === "image" || assetDurationSeconds[asset.id] !== undefined) continue;
      const probe = asset.kind === "video" ? getVideoDuration(asset.url) : getAudioDuration(asset.url);
      probe
        .then((duration) => {
          if (!cancelled) setAssetDurationSeconds((prev) => ({ ...prev, [asset.id]: duration }));
        })
        .catch(() => {
          // Leaves this tile without a duration badge -- not worth
          // surfacing a probe failure as a page-level error.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [assets, assetDurationSeconds]);

  function getAudioElement() {
    if (audioRef.current) return audioRef.current;
    const audio = new Audio();
    audio.addEventListener("timeupdate", () => {
      if (audio.duration) setPlaybackProgress(audio.currentTime / audio.duration);
    });
    audio.addEventListener("ended", () => {
      setPlayingAssetId(null);
      setPlaybackProgress(0);
    });
    audioRef.current = audio;
    return audio;
  }

  function handleTogglePlay(asset: Asset) {
    const audio = getAudioElement();
    if (playingAssetId === asset.id) {
      audio.pause();
      setPlayingAssetId(null);
      return;
    }
    audio.src = asset.url;
    audio.currentTime = 0;
    setPlaybackProgress(0);
    void audio.play();
    setPlayingAssetId(asset.id);
  }

  // Stops playback (rather than leaving an <audio> element silently
  // running) if this gallery unmounts mid-playback -- switching reels
  // shouldn't leave a previous project's music audible.
  useEffect(() => {
    return () => audioRef.current?.pause();
  }, []);

  async function handleDelete(asset: Asset) {
    if (!window.confirm(`Delete "${asset.filename}"? This can't be undone.`)) return;
    setDeletingAssetIds((prev) => new Set(prev).add(asset.id));
    try {
      await deleteAsset(asset.id);
      onDeleted(asset.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete this asset");
      // Only clear the in-flight flag on failure -- on success the tile is
      // about to unmount entirely once onDeleted() drops it from `assets`,
      // so there's nothing left to un-flag.
      setDeletingAssetIds((prev) => {
        const next = new Set(prev);
        next.delete(asset.id);
        return next;
      });
    }
  }

  function renderTile(asset: Asset) {
    const thumbnailSrc = asset.kind === "image" ? imageThumbnailSrcById[asset.id] : videoThumbnailUrlByAssetId[asset.id];
    const isDeleting = deletingAssetIds.has(asset.id);
    return (
      <button
        key={asset.id}
        type="button"
        title={asset.filename}
        disabled={isDeleting}
        onClick={() => onSelect(asset)}
        onContextMenu={(e) => {
          if (isDeleting) return;
          openContextMenu(e, [
            ...(asset.kind === "audio"
              ? [
                  {
                    label: playingAssetId === asset.id ? "Pause" : "Play",
                    onSelect: () => handleTogglePlay(asset),
                  },
                ]
              : []),
            ...(asset.kind === "image"
              ? [
                  { label: "Cutaway", onSelect: () => onOpenCutawayDialogForAsset(asset) },
                  { label: "Overlay", onSelect: () => onAddImageOverlay(asset) },
                ]
              : asset.kind === "video"
                ? [
                    { label: "Cutaway", onSelect: () => onAddToSequence(asset) },
                    { label: "Overlay", onSelect: () => onAddVideoOverlay(asset) },
                  ]
                : asset.kind === "audio"
                  ? [{ label: "Add", onSelect: () => onAddToBackgroundSequence(asset) }]
                  : []),
            { label: "Delete", danger: true, onSelect: () => void handleDelete(asset) },
          ]);
        }}
        className={
          "relative aspect-square w-16 shrink-0 overflow-hidden rounded-md border-2 disabled:cursor-not-allowed " +
          (selectedAssetId === asset.id ? "border-accent" : "border-transparent")
        }
      >
        {asset.kind === "audio" ? (
          <span className="relative flex h-full w-full items-center justify-center bg-neutral-800">
            {playingAssetId === asset.id ? (
              <>
                <PauseIcon className="h-5 w-5 text-accent" />
                <svg viewBox="0 0 36 36" className="absolute h-full w-full -rotate-90">
                  <circle
                    cx="18"
                    cy="18"
                    r={RING_RADIUS}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-white/20"
                  />
                  <circle
                    cx="18"
                    cy="18"
                    r={RING_RADIUS}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray={RING_CIRCUMFERENCE}
                    strokeDashoffset={RING_CIRCUMFERENCE * (1 - playbackProgress)}
                    className="text-accent"
                  />
                </svg>
              </>
            ) : (
              <MusicNoteIcon className="h-5 w-5 text-muted" />
            )}
          </span>
        ) : thumbnailSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived data:/presigned URL, not a Next-optimizable static asset
          <img src={thumbnailSrc} alt={asset.filename} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-neutral-800 text-xs text-muted">
            {asset.kind === "video" ? "▶" : "🖼"}
          </span>
        )}

        {usedAssetIds.has(asset.id) && (
          <span
            title="In use"
            className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-accent-foreground"
          >
            +
          </span>
        )}

        {asset.kind !== "image" && assetDurationSeconds[asset.id] !== undefined && (
          <span className="absolute bottom-0.5 left-0.5 rounded-sm bg-black/70 px-1 py-px text-[9px] leading-none text-white">
            {formatDuration(assetDurationSeconds[asset.id])}
          </span>
        )}

        {isDeleting && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/60">
            <svg viewBox="0 0 24 24" className="h-5 w-5 animate-spin text-white" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="9" strokeOpacity={0.3} />
              <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
            </svg>
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Assets</h2>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={onBrowseStock} className="text-xs text-accent hover:underline">
            + Stock
          </button>
          <button type="button" onClick={onAddAsset} className="text-xs text-accent hover:underline">
            + Asset
          </button>
        </div>
      </div>

      {isLoading && assets.length === 0 ? (
        <ReelLoader stage="Loading assets…" className="p-0" />
      ) : (
        <div className="flex flex-1 gap-2 overflow-hidden">
          {ASSET_SECTIONS.map(({ kind, label, emptyText }) => {
            const sectionAssets = assets.filter((asset) => asset.kind === kind);
            return (
              <div key={kind} className="flex min-w-0 flex-1 flex-col gap-1">
                <h3 className="text-center text-[10px] font-medium uppercase tracking-wide text-muted">{label}</h3>
                <div className="flex flex-1 flex-col items-center gap-2 overflow-y-auto">
                  {sectionAssets.length === 0 ? (
                    <p className="text-center text-[10px] text-muted">{emptyText}</p>
                  ) : (
                    sectionAssets.map(renderTile)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}
