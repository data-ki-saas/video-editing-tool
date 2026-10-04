/**
 * The template catalog for text overlays -- see video_math.ts's TextOverlay
 * and CanvasPlayer.tsx's compositing loop. Each template is a small, pure
 * canvas-drawing function: given the text, its resolved pixel rect, and a
 * 0..1 progress value (video_math.ts's computeProgress) through the
 * overlay's own time range, it draws whatever that template's look is.
 *
 * This is deliberately the ONLY place font/color/animation choices live --
 * TextOverlayDialog just lets someone type text and pick one of these by
 * name, with no separate font/color/animation controls exposed. Matches
 * this app's established preference for simple, direct-manipulation
 * controls over exposing every knob (see UserActions.tsx's own
 * TEMPLATE_OPTIONS picker for the same pattern applied to whole-project
 * style).
 *
 * Every template wraps and auto-shrinks its text to fit rectPx via
 * fitTextToRect below, rather than drawing one line at whatever size looks
 * good in isolation and letting it overflow the caption box -- the same
 * wrapping/auto-shrink the export uses, not a preview-only fix.
 */
import { easeInOut, type TtsWordTiming } from "./video_math";
import { drawLabel, getLabelSpec } from "./labelTemplates";
import { drawHeadline } from "./headlineTemplates";

export type TextTemplateId =
  | "bold-pop"
  | "minimal-subtitle"
  | "typewriter"
  | "bounce-in"
  | "highlight-box"
  | "neon-glow"
  | "word-pop";

export interface TextTemplateOption {
  id: TextTemplateId;
  name: string;
}

export const TEXT_TEMPLATE_OPTIONS: TextTemplateOption[] = [
  { id: "bold-pop", name: "Bold Pop" },
  { id: "minimal-subtitle", name: "Minimal Subtitle" },
  { id: "typewriter", name: "Typewriter" },
  { id: "bounce-in", name: "Bounce In" },
  { id: "highlight-box", name: "Highlight Box" },
  { id: "neon-glow", name: "Neon Glow" },
  { id: "word-pop", name: "Word Pop" },
];

export interface TextTemplateRenderContext {
  ctx: CanvasRenderingContext2D;
  text: string;
  rectPx: { x: number; y: number; width: number; height: number };
  /** 0..1 through the overlay's own time range, clamped -- see
   * video_math.ts's computeProgress. Drives each template's own
   * entrance/exit animation; templates with no animation just ignore it
   * past an initial fade-in. */
  progress: number;
}

export type TextTemplateRenderer = (context: TextTemplateRenderContext) => void;

export function rectCenter(rectPx: TextTemplateRenderContext["rectPx"]) {
  return { x: rectPx.x + rectPx.width / 2, y: rectPx.y + rectPx.height / 2 };
}

export function fontSizeFor(rectPx: TextTemplateRenderContext["rectPx"], fraction: number): number {
  return Math.max(10, rectPx.height * fraction);
}

// Each template's base font size, as a fraction of its rect's height --
// used by the canvas renderers below (via fontSizeFor).
const TEXT_TEMPLATE_FONT_FRACTIONS: Record<TextTemplateId, number> = {
  "bold-pop": 0.5,
  "minimal-subtitle": 0.3,
  typewriter: 0.4,
  "bounce-in": 0.5,
  "highlight-box": 0.35,
  "neon-glow": 0.5,
  "word-pop": 0.4,
};

/** Same boundary-crossing reasoning as getTextTemplateRenderer below --
 * templateId arrives as a plain, possibly-unknown string. Falls back to
 * 0.4 (a reasonable middle value) for an unrecognized id. */
export function getTextTemplateFontFraction(templateId: string): number {
  return (TEXT_TEMPLATE_FONT_FRACTIONS as Record<string, number>)[templateId] ?? 0.4;
}

// The four templates whose look depends on a thick black outline for
// legibility over busy footage (Bold Pop, Bounce In, Word Pop, Typewriter --
// the others either have no stroke at all or draw their own backing shape
// instead, e.g. Highlight Box's pill). Each renderer below multiplies its
// OWN computed font size by this fraction for ctx.lineWidth -- shared here,
// same "one source of truth" reasoning as TEXT_TEMPLATE_FONT_FRACTIONS
// above.
const STROKE_WIDTH_FONT_SIZE_FRACTIONS: Partial<Record<TextTemplateId, number>> = {
  "bold-pop": 0.12,
  "bounce-in": 0.12,
  "word-pop": 0.08,
  typewriter: 0.08,
};

/** A brief overshoot/elastic-feeling ease for entrances that should read
 * as a "bounce" rather than a smooth glide -- distinct from video_math.ts's
 * easeInOut, which is used where a plain smooth curve is wanted instead. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const clamped = Math.min(Math.max(t, 0), 1);
  return 1 + c3 * Math.pow(clamped - 1, 3) + c1 * Math.pow(clamped - 1, 2);
}

const MIN_FONT_SIZE_PX = 10;
const LINE_HEIGHT_MULTIPLIER = 1.15;

/** Greedy word-wrap at the current ctx.font -- one array of words per
 * line, not a joined string, so callers that stagger per word (Word Pop)
 * can still tell which line each word landed on. A single word wider than
 * maxWidthPx on its own is left alone (no hyphenation) rather than broken
 * mid-word; fitTextToRect's font-shrinking loop is what actually resolves
 * that case in practice. */
function wrapWords(ctx: CanvasRenderingContext2D, words: string[], maxWidthPx: number): string[][] {
  const lines: string[][] = [];
  let current: string[] = [];
  let currentText = "";

  for (const word of words) {
    const candidateText = current.length > 0 ? `${currentText} ${word}` : word;
    if (current.length > 0 && ctx.measureText(candidateText).width > maxWidthPx) {
      lines.push(current);
      current = [word];
      currentText = word;
    } else {
      current.push(word);
      currentText = candidateText;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export interface WrappedTextLayout {
  /** Words grouped per line -- for per-word stagger (Word Pop). */
  lineWords: string[][];
  /** Same lines, pre-joined -- for every template that just draws whole
   * lines. */
  lines: string[];
  fontSize: number;
  lineHeightPx: number;
}

/** Wraps `text` to fit within `maxWidthPx`/`maxHeightPx`, shrinking the
 * font size from `baseFontSizePx` down to a floor (re-wrapping at each
 * size) until every line fits the width and the whole block fits the
 * height -- rather than letting a long caption or a single long word
 * overflow its box, which every template used to do (single fillText call,
 * no wrapping at all). `fontSpec` builds the ctx.font string for a given
 * size (so callers keep their own weight/family, e.g. "bold ...px
 * sans-serif"). */
export function fitTextToRect(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidthPx: number,
  maxHeightPx: number,
  baseFontSizePx: number,
  fontSpec: (fontSizePx: number) => string
): WrappedTextLayout {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return { lineWords: [], lines: [], fontSize: baseFontSizePx, lineHeightPx: baseFontSizePx * LINE_HEIGHT_MULTIPLIER };
  }

  let fontSize = baseFontSizePx;
  while (fontSize > MIN_FONT_SIZE_PX) {
    ctx.font = fontSpec(fontSize);
    const lineWords = wrapWords(ctx, words, maxWidthPx);
    const lineHeightPx = fontSize * LINE_HEIGHT_MULTIPLIER;
    const blockHeight = lineWords.length * lineHeightPx;
    const lines = lineWords.map((line) => line.join(" "));
    const widestLinePx = Math.max(...lines.map((line) => ctx.measureText(line).width));
    if (blockHeight <= maxHeightPx && widestLinePx <= maxWidthPx) {
      return { lineWords, lines, fontSize, lineHeightPx };
    }
    fontSize -= 1;
  }

  ctx.font = fontSpec(MIN_FONT_SIZE_PX);
  const lineWords = wrapWords(ctx, words, maxWidthPx);
  return {
    lineWords,
    lines: lineWords.map((line) => line.join(" ")),
    fontSize: MIN_FONT_SIZE_PX,
    lineHeightPx: MIN_FONT_SIZE_PX * LINE_HEIGHT_MULTIPLIER,
  };
}

/** Draws each line of a wrapped block centered on (centerX, centerY),
 * stacked with `lineHeightPx` spacing -- the shared vertical layout every
 * center-anchored template (Bold Pop, Bounce In, Highlight Box, Neon Glow)
 * uses, so only the per-line draw call itself differs between them. */
export function forEachCenteredLine(
  layout: WrappedTextLayout,
  centerX: number,
  centerY: number,
  draw: (line: string, x: number, y: number) => void
) {
  const totalHeight = layout.lines.length * layout.lineHeightPx;
  const startY = centerY - totalHeight / 2 + layout.lineHeightPx / 2;
  layout.lines.forEach((line, index) => draw(line, centerX, startY + index * layout.lineHeightPx));
}

const boldPop: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const center = rectCenter(rectPx);
  const entrance = easeInOut(Math.min(progress / 0.2, 1));
  const scale = 0.8 + 0.2 * entrance;
  const baseFontSize = fontSizeFor(rectPx, TEXT_TEMPLATE_FONT_FRACTIONS["bold-pop"]);
  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  const layout = fitTextToRect(ctx, text, rectPx.width, rectPx.height, baseFontSize, fontSpec);

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(scale, scale);
  ctx.font = fontSpec(layout.fontSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = layout.fontSize * STROKE_WIDTH_FONT_SIZE_FRACTIONS["bold-pop"]!;
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  forEachCenteredLine(layout, 0, 0, (line, x, y) => {
    ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
  });
  ctx.restore();
};

const minimalSubtitle: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  ctx.save();
  ctx.globalAlpha = easeInOut(Math.min(progress / 0.1, 1));

  const barHeight = rectPx.height * 0.7;
  const barY = rectPx.y + rectPx.height - barHeight;
  const radius = barHeight * 0.2;
  const textPaddingX = rectPx.width * 0.06;
  const fontSpec = (size: number) => `${size}px sans-serif`;
  const layout = fitTextToRect(
    ctx,
    text,
    rectPx.width - textPaddingX * 2,
    barHeight * 0.8,
    fontSizeFor(rectPx, TEXT_TEMPLATE_FONT_FRACTIONS["minimal-subtitle"]),
    fontSpec
  );

  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.beginPath();
  ctx.roundRect(rectPx.x, barY, rectPx.width, barHeight, radius);
  ctx.fill();

  ctx.font = fontSpec(layout.fontSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "white";
  forEachCenteredLine(layout, rectPx.x + rectPx.width / 2, barY + barHeight / 2, (line, x, y) => ctx.fillText(line, x, y));
  ctx.restore();
};

const typewriter: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const fontSpec = (size: number) => `${size}px monospace`;
  const layout = fitTextToRect(
    ctx,
    text,
    rectPx.width,
    rectPx.height,
    fontSizeFor(rectPx, TEXT_TEMPLATE_FONT_FRACTIONS["typewriter"]),
    fontSpec
  );
  const totalChars = layout.lines.reduce((sum, line) => sum + line.length, 0);
  let revealBudget = Math.floor(progress * totalChars);

  ctx.save();
  ctx.font = fontSpec(layout.fontSize);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "white";
  ctx.strokeStyle = "black";
  ctx.lineWidth = layout.fontSize * STROKE_WIDTH_FONT_SIZE_FRACTIONS["typewriter"]!;

  const totalHeight = layout.lines.length * layout.lineHeightPx;
  const startY = rectPx.y + rectPx.height / 2 - totalHeight / 2 + layout.lineHeightPx / 2;
  layout.lines.forEach((line, index) => {
    if (revealBudget <= 0) return;
    const visible = line.slice(0, Math.min(revealBudget, line.length));
    revealBudget -= visible.length;
    const y = startY + index * layout.lineHeightPx;
    ctx.strokeText(visible, rectPx.x, y);
    ctx.fillText(visible, rectPx.x, y);
  });
  ctx.restore();
};

const bounceIn: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const center = rectCenter(rectPx);
  const scale = 0.5 + 0.5 * easeOutBack(Math.min(progress / 0.35, 1));
  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  const layout = fitTextToRect(
    ctx,
    text,
    rectPx.width,
    rectPx.height,
    fontSizeFor(rectPx, TEXT_TEMPLATE_FONT_FRACTIONS["bounce-in"]),
    fontSpec
  );

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(scale, scale);
  ctx.font = fontSpec(layout.fontSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = layout.fontSize * STROKE_WIDTH_FONT_SIZE_FRACTIONS["bounce-in"]!;
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  forEachCenteredLine(layout, 0, 0, (line, x, y) => {
    ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
  });
  ctx.restore();
};

const highlightBox: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const entrance = easeInOut(Math.min(progress / 0.2, 1));
  const boxWidth = rectPx.width * (0.85 + 0.15 * entrance);
  const boxHeight = rectPx.height * 0.7;
  const center = rectCenter(rectPx);
  const textPaddingX = boxWidth * 0.08;
  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  const layout = fitTextToRect(
    ctx,
    text,
    boxWidth - textPaddingX * 2,
    boxHeight * 0.8,
    fontSizeFor(rectPx, TEXT_TEMPLATE_FONT_FRACTIONS["highlight-box"]),
    fontSpec
  );

  ctx.save();
  ctx.globalAlpha = Math.min(progress / 0.1, 1);
  ctx.fillStyle = "#facc15";
  ctx.beginPath();
  ctx.roundRect(center.x - boxWidth / 2, center.y - boxHeight / 2, boxWidth, boxHeight, boxHeight * 0.15);
  ctx.fill();

  ctx.font = fontSpec(layout.fontSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#1c1917";
  forEachCenteredLine(layout, center.x, center.y, (line, x, y) => ctx.fillText(line, x, y));
  ctx.restore();
};

const neonGlow: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const center = rectCenter(rectPx);
  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  const layout = fitTextToRect(
    ctx,
    text,
    rectPx.width,
    rectPx.height,
    fontSizeFor(rectPx, TEXT_TEMPLATE_FONT_FRACTIONS["neon-glow"]),
    fontSpec
  );

  ctx.save();
  ctx.globalAlpha = easeInOut(Math.min(progress / 0.15, 1));
  ctx.font = fontSpec(layout.fontSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f0abfc";

  // Two passes at different blur radii build up a soft glow rather than
  // one flat blurred edge.
  forEachCenteredLine(layout, center.x, center.y, (line, x, y) => {
    ctx.shadowColor = "#e879f9";
    ctx.shadowBlur = layout.fontSize * 0.6;
    ctx.fillText(line, x, y);
    ctx.shadowBlur = layout.fontSize * 0.25;
    ctx.fillText(line, x, y);
  });
  ctx.restore();
};

const wordPop: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  const layout = fitTextToRect(
    ctx,
    text,
    rectPx.width,
    rectPx.height,
    fontSizeFor(rectPx, TEXT_TEMPLATE_FONT_FRACTIONS["word-pop"]),
    fontSpec
  );
  const totalWords = layout.lineWords.reduce((sum, line) => sum + line.length, 0);
  if (totalWords === 0) return;

  ctx.save();
  ctx.font = fontSpec(layout.fontSize);
  ctx.textBaseline = "middle";
  const spacing = ctx.measureText(" ").width;

  const totalHeight = layout.lineWords.length * layout.lineHeightPx;
  const startY = rectPx.y + rectPx.height / 2 - totalHeight / 2 + layout.lineHeightPx / 2;

  let globalWordIndex = 0;
  layout.lineWords.forEach((words, lineIndex) => {
    const wordWidths = words.map((word) => ctx.measureText(word).width);
    const lineWidth = wordWidths.reduce((sum, w) => sum + w, 0) + spacing * (words.length - 1);
    let x = rectPx.x + rectPx.width / 2 - lineWidth / 2;
    const y = startY + lineIndex * layout.lineHeightPx;

    words.forEach((word, wordIndexInLine) => {
      const wordProgress = Math.min(Math.max(progress * totalWords - globalWordIndex, 0), 1);
      const eased = easeInOut(wordProgress);
      ctx.save();
      ctx.globalAlpha = eased;
      ctx.translate(x + wordWidths[wordIndexInLine] / 2, y);
      ctx.scale(0.7 + 0.3 * eased, 0.7 + 0.3 * eased);
      ctx.textAlign = "center";
      ctx.fillStyle = "white";
      ctx.strokeStyle = "black";
      ctx.lineWidth = layout.fontSize * STROKE_WIDTH_FONT_SIZE_FRACTIONS["word-pop"]!;
      ctx.strokeText(word, 0, 0);
      ctx.fillText(word, 0, 0);
      ctx.restore();
      x += wordWidths[wordIndexInLine] + spacing;
      globalWordIndex += 1;
    });
  });
  ctx.restore();
};

export const TEXT_TEMPLATE_RENDERERS: Record<TextTemplateId, TextTemplateRenderer> = {
  "bold-pop": boldPop,
  "minimal-subtitle": minimalSubtitle,
  typewriter,
  "bounce-in": bounceIn,
  "highlight-box": highlightBox,
  "neon-glow": neonGlow,
  "word-pop": wordPop,
};

/** TextOverlay.templateId is persisted as a plain string, not the narrower
 * TextTemplateId union -- untyped JSON from Supabase can't guarantee it's
 * still a known id (e.g. after a template is ever renamed/removed).
 * Centralizes that lookup/cast in one place instead of an `as
 * TextTemplateId` at every call site; returns undefined for an unknown id,
 * which every caller already treats as "skip this overlay." */
export function getTextTemplateRenderer(templateId: string): TextTemplateRenderer | undefined {
  // "Label" overlays (labelTemplates.ts) are TextOverlays with a `label:`
  // templateId -- delegated here so every existing call site (CanvasPlayer,
  // exportTimeline, TextOverlayCanvas) draws them with no changes of its own.
  const labelSpec = getLabelSpec(templateId);
  if (labelSpec?.headline) {
    const style = labelSpec.headline;
    const fill = labelSpec.parts[0].fg;
    return ({ ctx, text, rectPx, progress }) => drawHeadline(style, fill, ctx, text, rectPx, progress);
  }
  if (labelSpec) return ({ ctx, text, rectPx, progress }) => drawLabel(labelSpec, ctx, text, rectPx, progress);
  return (TEXT_TEMPLATE_RENDERERS as Record<string, TextTemplateRenderer>)[templateId];
}

// Karaoke shows a single line: as many words around the active one as fit
// the rect's width at the chosen size (see drawKaraokeCaption), never a
// wrapped multi-line block. Size is tuned by TtsOverlay.karaokeFontScale.
export const KARAOKE_FONT_SCALE_MIN = 0.5;
export const KARAOKE_FONT_SCALE_MAX = 2;

/** Which word the window should be centered on at `relativeMs` -- the exact
 * active word when one is currently speaking, or (during a pause between
 * words, e.g. a comma/sentence break in the synthesized audio -- these are
 * common, not just at the narration's very start/end) the most recently
 * spoken word, so the window holds steady through the gap instead of
 * snapping back to word 0. Before the first word has started, centers on
 * word 0 so the window shows the upcoming text. */
function resolveKaraokeCenterIndex(words: TtsWordTiming[], relativeMs: number): { activeIndex: number; centerIndex: number } {
  const activeIndex = words.findIndex((w) => relativeMs >= w.startMs && relativeMs < w.endMs);
  if (activeIndex !== -1) return { activeIndex, centerIndex: activeIndex };

  let centerIndex = 0;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].startMs <= relativeMs) centerIndex = i;
    else break;
  }
  return { activeIndex: -1, centerIndex };
}

/** Karaoke-highlight renderer for a TtsOverlay in "karaoke" displayMode --
 * a dedicated, simpler-than-the-above renderer (word-wrap + per-word
 * highlight only, no entrance/exit animation system) since this is driven
 * by which word is CURRENTLY active, not a single 0..1 progress value the
 * way every TEXT_TEMPLATE_RENDERERS entry is. Only lays out a sliding
 * window of KARAOKE_WORDS_BEFORE/AFTER words around the active one (see
 * resolveKaraokeCenterIndex), not the full narration text, via
 * fitTextToRect's own word-grouping (shared with Word Pop's per-word layout
 * above) so wrapping stays consistent with the rest of the app, then draws
 * the active word with a filled highlight pill and every other word plain
 * white-with-stroke. `windowWords` and the wrapped layout's own flattened
 * word order line up 1:1 (word-wrap only groups words into lines, it never
 * reorders or drops any), so `localActiveIndex` (activeIndex re-based to
 * the window's own start) can be compared directly against a running
 * counter while iterating the wrapped layout.
 *
 * Exported (not local to one component) so both CanvasPlayer.tsx's live
 * preview and lib/localRender/exportTimeline.ts's offline export draw
 * karaoke captions identically -- a preview/render mismatch here would be
 * exactly the kind of drift this codebase's shared-renderer convention
 * (getTextTemplateRenderer above) exists to avoid. `relativeMs` (not a
 * pre-resolved activeIndex) is what's passed in, since this needs it for
 * the pause-fallback centering above too -- both call sites already have
 * it as `(currentTimeSeconds - overlay.startTimeSeconds) * 1000`. */
export function drawKaraokeCaption(
  ctx: CanvasRenderingContext2D,
  rectPx: { x: number; y: number; width: number; height: number },
  words: TtsWordTiming[],
  relativeMs: number,
  templateId: string,
  fontScale = 1
) {
  if (words.length === 0) return;
  const { activeIndex, centerIndex } = resolveKaraokeCenterIndex(words, relativeMs);

  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  const scale = Math.min(Math.max(fontScale, KARAOKE_FONT_SCALE_MIN), KARAOKE_FONT_SCALE_MAX);
  const lineHeightFor = (size: number) => size * LINE_HEIGHT_MULTIPLIER;
  // One line must fit the rect's height too.
  let fontSize = Math.min(fontSizeFor(rectPx, getTextTemplateFontFraction(templateId)) * scale, rectPx.height / LINE_HEIGHT_MULTIPLIER);

  ctx.save();
  ctx.font = fontSpec(fontSize);
  // The active word alone must fit the width (pill padding included).
  const centerWidth = ctx.measureText(words[centerIndex].word).width;
  if (centerWidth > rectPx.width * 0.9) {
    fontSize = Math.max(MIN_FONT_SIZE_PX, (fontSize * rectPx.width * 0.9) / centerWidth);
    ctx.font = fontSpec(fontSize);
  }
  const spacing = ctx.measureText(" ").width;
  const widthOf = (i: number) => ctx.measureText(words[i].word).width;

  // Grow the window around the center word, alternating after/before, while
  // the whole line still fits.
  let windowStart = centerIndex;
  let windowEnd = centerIndex;
  let lineWidth = widthOf(centerIndex);
  const maxWidth = rectPx.width * 0.95;
  for (;;) {
    let grew = false;
    if (windowEnd + 1 < words.length) {
      const next = lineWidth + spacing + widthOf(windowEnd + 1);
      if (next <= maxWidth) {
        windowEnd += 1;
        lineWidth = next;
        grew = true;
      }
    }
    if (windowStart - 1 >= 0) {
      const next = lineWidth + spacing + widthOf(windowStart - 1);
      if (next <= maxWidth) {
        windowStart -= 1;
        lineWidth = next;
        grew = true;
      }
    }
    if (!grew) break;
  }

  const lineHeightPx = lineHeightFor(fontSize);
  const y = rectPx.y + rectPx.height / 2;
  let x = rectPx.x + rectPx.width / 2 - lineWidth / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let i = windowStart; i <= windowEnd; i += 1) {
    const word = words[i].word;
    const wordWidth = widthOf(i);
    const centerX = x + wordWidth / 2;
    if (i === activeIndex) {
      const paddingX = fontSize * 0.15;
      ctx.save();
      ctx.fillStyle = "#facc15";
      ctx.beginPath();
      ctx.roundRect(x - paddingX, y - lineHeightPx / 2 + 1, wordWidth + paddingX * 2, lineHeightPx - 2, lineHeightPx * 0.2);
      ctx.fill();
      ctx.fillStyle = "#1c1917";
      ctx.fillText(word, centerX, y);
      ctx.restore();
    } else {
      ctx.lineWidth = fontSize * 0.1;
      ctx.strokeStyle = "black";
      ctx.fillStyle = "white";
      ctx.strokeText(word, centerX, y);
      ctx.fillText(word, centerX, y);
    }
    x += wordWidth + spacing;
  }
  ctx.restore();
}
