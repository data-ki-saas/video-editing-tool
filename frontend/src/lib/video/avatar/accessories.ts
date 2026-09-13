/**
 * The Phase 7 accessory catalog -- small procedurally-drawn attachments
 * (sunglasses, a hat) a creator can add via a concrete edit ("add
 * sunglasses", edits.ts's "addAccessory" op) or by hand-authoring a Design's
 * `attachedAccessories` (design.ts). Each entry attaches at one of the owning
 * Topology's `anchors` (topology.ts) -- `anchorId` here MUST match a real
 * anchor id on whichever topology an avatar rides (today, only
 * "biped-simple"'s "head"/"handL"/"handR", see library.ts), and compile.ts's
 * compileAccessories throws if a Design references a mismatched pair, same
 * "fail loudly at the boundary" posture as every other cross-reference this
 * engine validates.
 *
 * Same procedural-canvas-art posture as placeholderAtlas.ts (this is NOT
 * real character art, just enough to prove the mechanism end to end) --
 * `draw` renders directly into a small canvas, cached as a decoded
 * HTMLImageElement per (accessoryAssetId, resolved color) pair so repeatedly
 * compiling the same accessory (e.g. two clips using the same avatar+
 * accessory) never redraws or re-decodes it twice.
 */

export interface AccessoryCatalogEntry {
  accessoryAssetId: string;
  name: string;
  // Which of the owning Topology's `anchors` (topology.ts) this rides.
  anchorId: string;
  // Fine per-accessory adjustment layered ON TOP of the anchor's own
  // `localOffset` -- lets more than one accessory share a single anchor
  // (e.g. both a hat and sunglasses riding "head") while each landing at its
  // own sensible spot, without needing a separate anchor per accessory kind.
  offsetFromAnchor: { x: number; y: number };
  width: number;
  height: number;
  // Where, within this accessory's own drawn image, the anchor's world
  // position should land -- same pivot convention as AvatarSkinPart's own
  // pivotX/pivotY (skin.ts).
  pivotX: number;
  pivotY: number;
  defaultColor: string;
  draw: (ctx: CanvasRenderingContext2D, color: string) => void;
}

function drawSunglasses(ctx: CanvasRenderingContext2D, color: string): void {
  // Two rounded lenses joined by a thin bridge -- centered in the canvas so
  // this entry's own pivotX/pivotY (half its width/height) lands exactly
  // between the lenses, i.e. right where a face's eye-line anchor sits.
  const lensWidth = 34;
  const lensHeight = 24;
  const gap = 10;
  const centerY = ctx.canvas.height / 2;
  const leftX = ctx.canvas.width / 2 - gap / 2 - lensWidth;
  const rightX = ctx.canvas.width / 2 + gap / 2;

  ctx.fillStyle = color;
  for (const x of [leftX, rightX]) {
    ctx.beginPath();
    ctx.roundRect(x, centerY - lensHeight / 2, lensWidth, lensHeight, 8);
    ctx.fill();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(leftX + lensWidth, centerY);
  ctx.lineTo(rightX, centerY);
  ctx.stroke();
}

function drawHat(ctx: CanvasRenderingContext2D, color: string): void {
  // A simple cap: a wide brim plus a rounded crown sitting just above it --
  // pivot (see HAT entry below) sits at the brim's own top edge, center, so
  // the accessory hangs DOWN from the "head" anchor onto the top of the
  // skull, same "attach point sits at one edge, art extends away from it"
  // convention library.ts's own head-part pivot already uses.
  const width = ctx.canvas.width;
  const brimHeight = 10;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, width, brimHeight, 5);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(width * 0.18, brimHeight - 4, width * 0.64, 46, 16);
  ctx.fill();
}

export const ACCESSORY_CATALOG: AccessoryCatalogEntry[] = [
  {
    accessoryAssetId: "sunglasses",
    name: "Sunglasses",
    anchorId: "head",
    // "head" anchor sits near the TOP of the skull (tuned for a hat, see
    // library.ts's own ANCHORS comment) -- sunglasses need to land lower, at
    // roughly eye level, hence a sizeable downward nudge here rather than
    // needing a second, eye-level anchor just for this one accessory.
    offsetFromAnchor: { x: 0, y: 54 },
    width: 90,
    height: 30,
    pivotX: 45,
    pivotY: 15,
    defaultColor: "#1a1a1a",
    draw: drawSunglasses,
  },
  {
    accessoryAssetId: "hat",
    name: "Hat",
    anchorId: "head",
    // No further nudge needed -- the "head" anchor is already positioned for
    // exactly this (see its own doc comment in library.ts).
    offsetFromAnchor: { x: 0, y: 0 },
    width: 110,
    height: 56,
    pivotX: 55,
    pivotY: 6,
    defaultColor: "#2b2b3d",
    draw: drawHat,
  },
];

export function getAccessoryCatalogEntry(accessoryAssetId: string): AccessoryCatalogEntry | null {
  return ACCESSORY_CATALOG.find((entry) => entry.accessoryAssetId === accessoryAssetId) ?? null;
}

// Keyed by `${accessoryAssetId}:${color}` -- an accessory drawn with the same
// color override (or none, i.e. its own defaultColor) never needs a second
// canvas draw/decode round trip.
const decodedImageCache = new Map<string, Promise<HTMLImageElement>>();

/** Renders `entry` (tinted `colorOverride`, or its own defaultColor) into a
 * small offscreen canvas and returns it as a decoded, drawable image --
 * promise-cached exactly like compile.ts's own loadAtlasImage, for the same
 * reason (two callers requesting the identical accessory+color before the
 * first decode finishes share one decode rather than duplicating it). */
export function loadAccessoryImage(entry: AccessoryCatalogEntry, colorOverride?: string): Promise<HTMLImageElement> {
  const color = colorOverride ?? entry.defaultColor;
  const key = `${entry.accessoryAssetId}:${color}`;
  const cached = decodedImageCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = entry.width;
    canvas.height = entry.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(`loadAccessoryImage: 2D context unavailable for "${entry.accessoryAssetId}"`);
    entry.draw(ctx, color);

    const image = new Image();
    image.src = canvas.toDataURL("image/png");
    await image.decode();
    return image;
  })();

  promise.catch(() => {
    if (decodedImageCache.get(key) === promise) decodedImageCache.delete(key);
  });
  decodedImageCache.set(key, promise);
  return promise;
}
