/**
 * Automatic "Made by myreels.in" attribution burned into the last couple
 * seconds of every export -- NOT a user-authored TextOverlay (no dialog, no
 * toggle, doesn't live in Timeline/SequenceEntry state at all): it's always
 * present regardless of what else is on the timeline, the same way a
 * finished render always carries this app's own branding.
 *
 * One shared draw function so CanvasPlayer's live preview and
 * lib/localRender/exportTimeline.ts's local render (both plain 2D canvas
 * compositing) can't drift from each other -- same "one source of truth"
 * discipline as textTemplates.ts. The cloud path
 * (compileCreatomateTimeline.ts) never touches a canvas, so it draws the
 * equivalent look with real Creatomate Text/backgroundColor properties
 * instead (buildBrandWatermarkElement there) -- it imports the same
 * TEXT/DURATION/PADDING_FRACTION/FONT_SIZE_FRACTION constants below rather
 * than hand-duplicating them, so the two can't silently drift apart the
 * way this app's own caption templates already learned NOT to (see
 * textTemplates.ts's TEXT_TEMPLATE_FONT_FRACTIONS/
 * STROKE_WIDTH_FONT_SIZE_FRACTIONS).
 */
export const BRAND_WATERMARK_TEXT = "Made by myreels.in";
export const BRAND_WATERMARK_DURATION_SECONDS = 2;

// Fractions of the canvas's own SMALLER dimension (matches this app's fixed
// portrait output, but stays sane if that ever changes) -- so padding/text
// size scale with output resolution rather than using fixed pixel values
// tuned for one size.
export const PADDING_FRACTION = 0.04;
export const FONT_SIZE_FRACTION = 0.032;
export const FADE_IN_SECONDS = 0.25;

export function isBrandWatermarkActive(elapsedSeconds: number, totalDurationSeconds: number): boolean {
  return totalDurationSeconds > 0 && elapsedSeconds >= totalDurationSeconds - BRAND_WATERMARK_DURATION_SECONDS;
}

/** Draws directly onto `ctx` at its current canvas size -- call this LAST,
 * after every other overlay/caption, so the attribution is never covered
 * by anything else on the frame. Top-right corner, padded off both edges,
 * a solid dark pill behind white bold text -- the same "background box,
 * not just an outline" approach this app's own Minimal Subtitle/Highlight
 * Box caption templates use (textTemplates.ts) for the identical "must
 * stay legible over arbitrary busy footage" problem, chosen over a stroke
 * outline because a solid box guarantees contrast regardless of what's
 * behind it. No-op outside the active window (see isBrandWatermarkActive)
 * -- callers don't need their own guard first. */
export function drawBrandWatermark(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  elapsedSeconds: number,
  totalDurationSeconds: number
): void {
  if (!isBrandWatermarkActive(elapsedSeconds, totalDurationSeconds)) return;

  const minDimension = Math.min(canvasWidth, canvasHeight);
  const padding = minDimension * PADDING_FRACTION;
  const fontSize = minDimension * FONT_SIZE_FRACTION;
  const sinceStart = elapsedSeconds - (totalDurationSeconds - BRAND_WATERMARK_DURATION_SECONDS);

  ctx.save();
  ctx.globalAlpha = Math.min(Math.max(sinceStart / FADE_IN_SECONDS, 0), 1);
  ctx.font = `700 ${fontSize}px sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  const textWidth = ctx.measureText(BRAND_WATERMARK_TEXT).width;

  const boxPaddingX = fontSize * 0.5;
  const boxPaddingY = fontSize * 0.35;
  const boxWidth = textWidth + boxPaddingX * 2;
  const boxHeight = fontSize + boxPaddingY * 2;
  const boxX = canvasWidth - padding - boxWidth;
  const boxY = padding;

  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxWidth, boxHeight, boxHeight * 0.3);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.fillText(BRAND_WATERMARK_TEXT, canvasWidth - padding - boxPaddingX, boxY + boxPaddingY);
  ctx.restore();
}
