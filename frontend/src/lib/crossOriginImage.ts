/**
 * The one safe way to load a project asset's presigned R2 URL as an
 * <img>-usable image anywhere in this app. Plain `<img src={asset.url}>` (or
 * `new Image(); img.src = url`) requests the URL in the browser's "no-cors"
 * mode -- fine for just displaying pixels, but the browser can then cache
 * that response as an opaque, header-less entry keyed to that exact URL.
 * Any LATER same-URL request made in "cors" mode (e.g. CanvasPlayer drawing
 * the same asset onto a canvas for the live preview, which needs to read
 * pixels back out) can be served that cached opaque response instead of a
 * fresh CORS-checked one -- which fails with "No 'Access-Control-Allow-
 * Origin' header is present" even though the bucket's real CORS policy is
 * completely correct. This was a real, hard-to-diagnose production
 * incident: curl and a fresh top-level navigation to the exact failing URL
 * both succeeded every time (neither shares the page's cache), while the
 * live app failed consistently across devices/networks, because a plain
 * `<img>` load elsewhere on the page (the asset gallery thumbnail, a Cutaway
 * preview, this wizard's own dimension probe) had already poisoned the
 * cache for that URL moments earlier.
 *
 * The fix is to make EVERY load of a project asset's URL go through an
 * explicit `fetch(url, { mode: "cors" })`, converted to a blob and then to a
 * same-origin `blob:` URL -- that forces a real CORS-checked network
 * request every time (no ambiguous cache reuse), and the resulting <img>
 * never touches the cross-origin URL again. This exact pattern already
 * existed in CanvasPlayer.tsx (the one place that discovered the bug, for
 * captureFrame()'s canvas readback) -- pulled out here so every other
 * caller uses the identical, already-proven-safe implementation instead of
 * a plain `<img>`/`new Image()` that could re-poison the cache for
 * everyone else.
 */
export interface LoadedCrossOriginImage {
  image: HTMLImageElement;
  /** A same-origin blob: URL wrapping the fetched bytes -- valid until you
   * call URL.revokeObjectURL(blobUrl). Revoke it once you're done reading
   * pixels (CanvasPlayer, dimension probes) or on cleanup/url-change if
   * you're using it as a long-lived <img src>. */
  blobUrl: string;
}

export function loadCrossOriginImage(url: string): Promise<LoadedCrossOriginImage> {
  return fetch(url, { mode: "cors" })
    .then((res) => {
      if (!res.ok) throw new Error(`Could not fetch image (HTTP ${res.status})`);
      return res.blob();
    })
    .then(
      (blob) =>
        new Promise<LoadedCrossOriginImage>((resolve, reject) => {
          const blobUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => resolve({ image: img, blobUrl });
          img.onerror = () => {
            URL.revokeObjectURL(blobUrl);
            reject(new Error("Could not decode image"));
          };
          img.src = blobUrl;
        })
    );
}
