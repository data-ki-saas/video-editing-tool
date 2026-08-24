"use client";

/**
 * Client-side downscale for image uploads -- run before the file ever
 * leaves the browser, since the backend has no image-processing dependency
 * (see backend/src/assets/service.py) and this app deliberately avoids
 * adding heavy processing to the Render-hosted backend, same reasoning as
 * the existing client-side video-frame/audio extraction in lib/video/. An
 * overlay image is drawn at a fraction of the output video frame, which
 * itself caps at 1920px on the long edge (video_math.ts's
 * computeOutputDimensions) -- a multi-megapixel phone photo stored at full
 * resolution is pure waste (R2 storage, and transfer time during both the
 * live preview and a free render's own asset fetch).
 */
const MAX_LONG_EDGE_PX = 2048;
const JPEG_QUALITY = 0.85;

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode the selected image"));
    img.src = url;
  });
}

/**
 * Downscales `file` to at most MAX_LONG_EDGE_PX on its longer edge, if it's
 * currently larger -- never upscales, and leaves non-image files and
 * already-small images untouched. Re-encodes at the SAME mime type as the
 * input, so a PNG (which might carry real transparency) stays a lossless
 * PNG and only a JPEG gets JPEG_QUALITY applied -- browsers ignore the
 * quality argument for any output type other than JPEG/WebP. Falls back to
 * returning the original file unchanged if anything about the resize
 * fails, rather than blocking the upload on a resize bug.
 */
export async function downscaleImageIfNeeded(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(objectUrl);
    const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
    if (longEdge <= MAX_LONG_EDGE_PX) return file;

    const scale = MAX_LONG_EDGE_PX / longEdge;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, file.type, JPEG_QUALITY));
    if (!blob) return file;

    return new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
