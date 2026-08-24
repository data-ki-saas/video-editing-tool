"use client";

/**
 * Thumbnail row of this project's uploaded assets, replacing the
 * always-visible upload dropzone from the original ActionArea design.
 * Clicking a tile selects that asset (drives the play area + Playground
 * timeline in ThreePaneEditor); "+ Asset" opens UploadDialog instead of a
 * permanent drop target taking up space; right-click offers Delete, plus
 * an "Add" action whose meaning depends on kind: for an image, places it
 * as an overlay on the timeline (ThreePaneEditor's handleAddOverlay); for
 * a video, appends it to the concatenated video sequence (handleAddToSequence
 * -- the first Add is what starts rendering frames at all, every later one
 * plays right after whatever's already there); for music, appends it to
 * the background-music sequence (handleAddToBackgroundSequence -- multiple
 * appended tracks concatenate, then loop as a whole across the video's
 * duration), same slot as picking one from the curated
 * BackgroundTrackSelector list. A small "+" badge marks a tile as
 * currently in use (referenced by an overlay, in the video sequence, or in
 * the background sequence), mirroring the selected-tile border rather than
 * being a separate concept. Thumbnails are a fixed square, regardless of
 * asset kind/aspect ratio.
 *
 * Music tiles also get a "Play"/"Pause" action -- plays right there in the
 * tile (a plain hidden <audio>, driven entirely by JS, not the browser's
 * native control bar) with a circular progress ring animated over the
 * music-note icon, rather than opening any kind of popup. Only one track
 * plays at a time; starting a second stops whichever was already playing.
 */
import { useEffect, useRef, useState } from "react";
import { deleteAsset, type Asset } from "@/lib/api";
import { captureSingleFrame } from "@/lib/video/video";
import { ReelLoader } from "@/components/ReelLoader";
import { MusicNoteIcon } from "@/components/icons/UIIcons";
import { PauseIcon } from "./icons/PlayerIcons";
import { ContextMenu, useContextMenu } from "./ContextMenu";

// SVG circumference for the progress ring (r=16 in a 36x36 viewBox) --
// shared by the ring's own stroke-dasharray and its progress-driven offset.
const RING_RADIUS = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function AssetGallery({
  assets,
  isLoading,
  selectedAssetId,
  onSelect,
  onAddAsset,
  onBrowseStock,
  onDeleted,
  onAddOverlay,
  onAddToSequence,
  onAddToBackgroundSequence,
  usedAssetIds,
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
  onAddOverlay: (asset: Asset) => void;
  onAddToSequence: (asset: Asset) => void;
  onAddToBackgroundSequence: (asset: Asset) => void;
  usedAssetIds: Set<string>;
}) {
  const [videoThumbnails, setVideoThumbnails] = useState<Record<string, string>>({});
  const [playingAssetId, setPlayingAssetId] = useState<string | null>(null);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

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

  // Generates one representative frame per video asset, once, the first
  // time it shows up here -- images use their own URL directly (no
  // extraction needed) and are skipped.
  useEffect(() => {
    let cancelled = false;
    for (const asset of assets) {
      if (asset.kind !== "video" || videoThumbnails[asset.id]) continue;
      captureSingleFrame(asset.url)
        .then((frame) => {
          if (!cancelled) setVideoThumbnails((prev) => ({ ...prev, [asset.id]: frame }));
        })
        .catch(() => {
          // Leaves this tile on the fallback icon below -- not worth
          // surfacing a gallery-thumbnail failure as a page-level error.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [assets, videoThumbnails]);

  async function handleDelete(asset: Asset) {
    if (!window.confirm(`Delete "${asset.filename}"? This can't be undone.`)) return;
    try {
      await deleteAsset(asset.id);
      onDeleted(asset.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete this asset");
    }
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

      <div className="flex flex-1 items-center gap-2 overflow-x-auto">
        {isLoading && assets.length === 0 && <ReelLoader stage="Loading assets…" className="p-0" />}
        {!isLoading && assets.length === 0 && <p className="self-center text-xs text-muted">No assets yet</p>}
        {assets.map((asset) => {
          const thumbnailSrc = asset.kind === "image" ? asset.url : videoThumbnails[asset.id];
          return (
            <button
              key={asset.id}
              type="button"
              title={asset.filename}
              onClick={() => onSelect(asset)}
              onContextMenu={(e) =>
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
                    ? [{ label: "Add", onSelect: () => onAddOverlay(asset) }]
                    : asset.kind === "video"
                      ? [{ label: "Add", onSelect: () => onAddToSequence(asset) }]
                      : asset.kind === "audio"
                        ? [{ label: "Add", onSelect: () => onAddToBackgroundSequence(asset) }]
                        : []),
                  { label: "Delete", danger: true, onSelect: () => void handleDelete(asset) },
                ])
              }
              className={
                "relative aspect-square w-16 shrink-0 overflow-hidden rounded-md border-2 " +
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
            </button>
          );
        })}
      </div>

      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}
