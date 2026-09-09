/**
 * The whole-slide renderer for a Text Slide (video_math.ts's SequenceEntry
 * "text" variant) -- called identically from CanvasPlayer.tsx's live
 * preview and lib/localRender/exportTimeline.ts's offline export, same
 * "shared renderer, preview can't drift from export" convention as
 * textTemplates.ts's getTextTemplateRenderer/drawKaraokeCaption. Unlike
 * those (drawn ON TOP of the base video for a time range), a text slide
 * fully REPLACES the frame for its own duration -- there's no footage
 * underneath it to preserve, same as an image Cutaway.
 */
import { computeCoverFitSourceRect, type SequenceEntry } from "./video_math";
import { fitTextToRect } from "./textTemplates";
import { computeTextSlideTransform } from "./textSlideTransitions";
import { DEFAULT_CANVAS_FILL_COLOR, DEFAULT_CANVAS_FILL_GRADIENT_COLOR } from "./canvasFillPresets";

export type TextSlideEntry = Extract<SequenceEntry, { kind: "text" }>;

interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Inner margin every text region gets, as a fraction of its own rect --
// same "%-of-rect, not fixed px" convention as textTemplates.ts's own
// textPaddingX. Applied uniformly on all four sides.
const REGION_PADDING_FRACTION = 0.08;
// "image-full" layout's own bottom caption band -- same idea as
// textTemplates.ts's minimalSubtitle bar, just full-width and anchored to
// the slide's own bottom edge rather than the caption's authored rect.
const SCRIM_HEIGHT_FRACTION = 0.32;
const SCRIM_COLOR = "rgba(0, 0, 0, 0.55)";
// A neutral placeholder fill for an image region whose asset hasn't
// finished loading yet -- avoids drawing text over stale/blank canvas
// pixels for the brief window before the real photo is ready.
const LOADING_IMAGE_FILL_COLOR = "#1f2937";
// Fraction of the TEXT REGION's own height (not the whole slide) -- same
// role as textTemplates.ts's TEXT_TEMPLATE_FONT_FRACTIONS, just one flat
// value since a text slide has no per-template variety.
const BASE_FONT_SIZE_FRACTION = 0.16;

function paddedRect(rect: PixelRect, fraction: number): PixelRect {
  const paddingX = rect.width * fraction;
  const paddingY = rect.height * fraction;
  return { x: rect.x + paddingX, y: rect.y + paddingY, width: rect.width - paddingX * 2, height: rect.height - paddingY * 2 };
}

function drawBackgroundFill(
  ctx: CanvasRenderingContext2D,
  rect: PixelRect,
  mode: "solid" | "gradient" | null | undefined,
  color: string | undefined,
  gradientColor: string | undefined
) {
  if (mode === "gradient") {
    const gradient = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
    gradient.addColorStop(0, color ?? DEFAULT_CANVAS_FILL_COLOR);
    gradient.addColorStop(1, gradientColor ?? DEFAULT_CANVAS_FILL_GRADIENT_COLOR);
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = color ?? DEFAULT_CANVAS_FILL_COLOR;
  }
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
}

function drawImageRegion(ctx: CanvasRenderingContext2D, image: HTMLImageElement | null, rect: PixelRect) {
  if (!image) {
    ctx.fillStyle = LOADING_IMAGE_FILL_COLOR;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    return;
  }
  const { sx, sy, sWidth, sHeight } = computeCoverFitSourceRect(image.naturalWidth, image.naturalHeight, rect.width, rect.height);
  ctx.drawImage(image, sx, sy, sWidth, sHeight, rect.x, rect.y, rect.width, rect.height);
}

function drawSlideText(ctx: CanvasRenderingContext2D, entry: TextSlideEntry, rect: PixelRect) {
  const region = paddedRect(rect, REGION_PADDING_FRACTION);
  if (region.width <= 0 || region.height <= 0) return;

  const fontSpec = (size: number) => `${entry.style.italic ? "italic " : ""}${entry.style.bold ? "bold " : ""}${size}px sans-serif`;
  const baseFontSize = Math.max(10, region.height * BASE_FONT_SIZE_FRACTION);
  const layout = fitTextToRect(ctx, entry.text, region.width, region.height, baseFontSize, fontSpec);

  ctx.font = fontSpec(layout.fontSize);
  ctx.textBaseline = "middle";
  ctx.textAlign = entry.style.align;
  ctx.fillStyle = entry.style.color;

  const totalHeight = layout.lines.length * layout.lineHeightPx;
  const startY = region.y + region.height / 2 - totalHeight / 2 + layout.lineHeightPx / 2;
  const x = entry.style.align === "left" ? region.x : entry.style.align === "right" ? region.x + region.width : region.x + region.width / 2;
  layout.lines.forEach((line, index) => ctx.fillText(line, x, startY + index * layout.lineHeightPx));
}

/**
 * Draws one Text Slide entry, fully replacing `destRect` -- background (or
 * cover-fit image, per layout) plus the authored text, with the
 * entrance/exit transform (textSlideTransitions.ts) applied around the
 * whole thing. `elapsedSeconds` is time since THIS slide's own start (not
 * the sequence's), matching how ZoomEffect/textTemplates progress values
 * are always local to their own window. `imageElement` is null for
 * "text-only" (ignored) and while an image layout's asset is still loading.
 */
export function drawTextSlide(
  ctx: CanvasRenderingContext2D,
  entry: TextSlideEntry,
  destRect: PixelRect,
  elapsedSeconds: number,
  imageElement: HTMLImageElement | null
): void {
  const transform = computeTextSlideTransform(entry.entranceId, entry.exitId, elapsedSeconds, entry.durationSeconds);
  if (transform.opacity <= 0) return;

  ctx.save();
  ctx.globalAlpha = transform.opacity;
  ctx.translate(transform.translateXFraction * destRect.width, transform.translateYFraction * destRect.height);

  if (entry.layout === "text-only") {
    drawBackgroundFill(ctx, destRect, entry.canvasFillMode, entry.canvasFillColor, entry.canvasFillGradientColor);
    drawSlideText(ctx, entry, destRect);
  } else if (entry.layout === "image-full") {
    drawImageRegion(ctx, imageElement, destRect);
    const scrimRect: PixelRect = {
      x: destRect.x,
      y: destRect.y + destRect.height * (1 - SCRIM_HEIGHT_FRACTION),
      width: destRect.width,
      height: destRect.height * SCRIM_HEIGHT_FRACTION,
    };
    ctx.fillStyle = SCRIM_COLOR;
    ctx.fillRect(scrimRect.x, scrimRect.y, scrimRect.width, scrimRect.height);
    drawSlideText(ctx, entry, scrimRect);
  } else {
    const half = destRect.width / 2;
    const imageOnLeft = entry.layout === "image-left";
    const imageRect: PixelRect = { x: destRect.x + (imageOnLeft ? 0 : half), y: destRect.y, width: half, height: destRect.height };
    const textRect: PixelRect = { x: destRect.x + (imageOnLeft ? half : 0), y: destRect.y, width: half, height: destRect.height };
    drawBackgroundFill(ctx, textRect, entry.canvasFillMode, entry.canvasFillColor, entry.canvasFillGradientColor);
    drawImageRegion(ctx, imageElement, imageRect);
    drawSlideText(ctx, entry, textRect);
  }

  ctx.restore();
}
