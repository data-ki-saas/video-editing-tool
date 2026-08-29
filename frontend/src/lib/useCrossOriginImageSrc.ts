"use client";

/**
 * `<img src={useCrossOriginImageSrc(asset.url)} />` -- a drop-in replacement
 * for `<img src={asset.url} />` that never touches the cross-origin URL
 * directly (see crossOriginImage.ts's own module comment for why a plain
 * `<img src>` there can poison the browser's cache against a LATER
 * CORS-mode fetch of the same URL, e.g. CanvasPlayer's live preview).
 * Returns null while loading or on failure -- callers already have their
 * own placeholder/fallback for a falsy src (this matches how `asset.url`
 * itself could be falsy before).
 */
import { useEffect, useState } from "react";
import { loadCrossOriginImage } from "./crossOriginImage";

export function useCrossOriginImageSrc(url: string | null | undefined): string | null {
  const [blobSrc, setBlobSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change, same pattern as CutawayDialog's own re-sync effect
      setBlobSrc(null);
      return;
    }
    let cancelled = false;
    let ownBlobUrl: string | null = null;

    loadCrossOriginImage(url)
      .then(({ blobUrl }) => {
        if (cancelled) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        ownBlobUrl = blobUrl;
        setBlobSrc(blobUrl);
      })
      .catch(() => {
        if (!cancelled) setBlobSrc(null);
      });

    return () => {
      cancelled = true;
      if (ownBlobUrl) URL.revokeObjectURL(ownBlobUrl);
    };
  }, [url]);

  return blobSrc;
}

/** Batched sibling of useCrossOriginImageSrc above, for a list of tiles
 * rendered from a plain per-item render FUNCTION (not its own component) --
 * AssetGallery/MobileAssetStrip's `.map(renderTile)` can't call a hook once
 * per asset (that violates the rules of hooks the moment the asset count
 * changes between renders), so this resolves the whole list's worth of
 * blob src's in one hook call at the gallery's own top level instead, and
 * `renderTile` just does a plain `srcByAssetId[asset.id]` lookup. */
export function useCrossOriginImageSrcMap(items: { id: string; url: string }[]): Record<string, string> {
  const [srcById, setSrcById] = useState<Record<string, string>>({});
  // Content-based key (not the `items` array reference, which is a new
  // array every render even when nothing actually changed) -- the effect
  // below should only re-run when the actual set of ids/urls changes.
  const key = items.map((item) => `${item.id}:${item.url}`).join("|");

  useEffect(() => {
    let cancelled = false;
    const blobUrls: string[] = [];

    for (const { id, url } of items) {
      loadCrossOriginImage(url)
        .then(({ blobUrl }) => {
          if (cancelled) {
            URL.revokeObjectURL(blobUrl);
            return;
          }
          blobUrls.push(blobUrl);
          setSrcById((prev) => ({ ...prev, [id]: blobUrl }));
        })
        .catch(() => {
          // One broken thumbnail shouldn't block the rest of the gallery --
          // renderTile's own fallback (a plain kind icon) covers a missing src.
        });
    }

    return () => {
      cancelled = true;
      blobUrls.forEach((blobUrl) => URL.revokeObjectURL(blobUrl));
      setSrcById({});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` IS the real dependency; `items` itself is a fresh array reference every render
  }, [key]);

  return srcById;
}
