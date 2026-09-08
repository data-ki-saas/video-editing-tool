"use client";

/**
 * `<video src={useCrossOriginVideoSrc(recording.url)} />` -- a drop-in
 * replacement for `<video src={recording.url} />` that never touches a
 * private R2 asset's presigned URL directly (see crossOriginVideo.ts's own
 * module comment for why a plain `<video src>` there can poison the
 * browser's cache against a LATER CORS-mode fetch of the same URL, e.g.
 * RecordingEditDialog's trim popup). Returns null while loading or on
 * failure -- callers already tolerate a momentarily-empty `src` (same
 * contract as useCrossOriginImageSrc).
 */
import { useEffect, useState } from "react";
import { loadCrossOriginVideo } from "./crossOriginVideo";

export function useCrossOriginVideoSrc(url: string | null | undefined): string | null {
  const [blobSrc, setBlobSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change, same pattern as useCrossOriginImageSrc's own re-sync effect
      setBlobSrc(null);
      return;
    }
    let cancelled = false;
    let ownBlobUrl: string | null = null;

    loadCrossOriginVideo(url)
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
