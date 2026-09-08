/**
 * The video sibling of crossOriginImage.ts -- same reasoning, see that
 * file's own module comment for the fuller incident writeup. A plain
 * `<video src={asset.url}>` (no `crossOrigin` set) requests a private R2
 * asset's presigned URL in the browser's "no-cors" mode; the browser can
 * then cache that as an opaque, header-less response keyed to that exact
 * URL, and a LATER "cors"-mode fetch of the IDENTICAL URL (e.g.
 * RecordingEditDialog's own trim-popup fetch, which needs the real bytes
 * for mediabunny) can be served that cached opaque response instead of a
 * fresh CORS-checked one -- failing with "No 'Access-Control-Allow-Origin'
 * header is present" even though the bucket's CORS policy is completely
 * correct. `crossOrigin="anonymous"` on the `<video>` tag does NOT fix this
 * either (see crossOriginImage.ts) -- the poisoning happens at whichever
 * call site loads the URL first without it, not at the one that later
 * fails.
 *
 * The fix is the same one already applied to every image call site: force
 * a real `fetch(url, { mode: "cors" })` and hand the caller a same-origin
 * `blob:` URL to use as `<video src>` instead -- that URL never touches the
 * cross-origin origin again, so it can't poison (or be poisoned by) it.
 * Unlike streaming a `<video src>` straight off R2, this downloads the
 * whole file up front -- an acceptable tradeoff here since recordings are
 * capped at a few minutes (see CameraCapturePage.tsx's MAX_RECORDING_SECONDS
 * / RecordingUploadDialog's own limits), and RecordingEditDialog already
 * pays this same cost for the identical file when Trim is opened.
 */
export interface LoadedCrossOriginVideo {
  /** A same-origin blob: URL wrapping the fetched bytes -- valid until you
   * call URL.revokeObjectURL(blobUrl). */
  blobUrl: string;
}

export function loadCrossOriginVideo(url: string): Promise<LoadedCrossOriginVideo> {
  return fetch(url, { mode: "cors" })
    .then((res) => {
      if (!res.ok) throw new Error(`Could not fetch video (HTTP ${res.status})`);
      return res.blob();
    })
    .then((blob) => ({ blobUrl: URL.createObjectURL(blob) }));
}
