/**
 * The style catalog for auto-generated (transcript) captions -- see
 * video_math.ts's TranscriptCaption and
 * lib/timeline/compileCreatomateTimeline.ts's buildTranscriptCaptionElements.
 * Deliberately a SEPARATE, smaller catalog from textTemplates.ts's 7
 * manual-caption templates, not a variant of them: manual captions use
 * whole-caption enter animations (scale-in, typewriter); these map to
 * Creatomate's own `transcriptEffect` property, a per-word/line reveal
 * driven by word-level timing Creatomate extracts from the video's audio
 * during rendering -- a genuinely different mechanism, so folding the two
 * catalogs together would mean offering effects that don't apply to
 * whichever caption kind was actually chosen.
 *
 * There is no live preview of the real transcript -- it doesn't exist
 * until render time. Every renderer below draws the same fixed 3-word
 * placeholder ("Your Words Here"), treating the middle word as
 * "currently spoken," as a single static approximation of each effect's
 * look -- enough to judge color/weight/position, not a real animation.
 */
import { fontSizeFor, rectCenter, type TextTemplateRenderContext, type TextTemplateRenderer } from "./textTemplates";
// Type-only -- erased at compile time, so this never pulls the actual
// `creatomate` package (Node-only, see compileCreatomateTimeline.ts's own
// comment) into this file's client bundle. Just borrowing the exact
// TranscriptEffect/TranscriptSplit string unions so a typo here would be
// a type error, not a silent bad value sent to Creatomate.
import type { TranscriptEffect, TranscriptSplit } from "creatomate";

export type TranscriptCaptionTemplateId = "color" | "karaoke" | "highlight" | "fade" | "bounce" | "slide" | "enlarge";

export interface TranscriptCaptionTemplateOption {
  id: TranscriptCaptionTemplateId;
  name: string;
}

export const TRANSCRIPT_CAPTION_TEMPLATE_OPTIONS: TranscriptCaptionTemplateOption[] = [
  { id: "color", name: "Color Swap" },
  { id: "karaoke", name: "Karaoke" },
  { id: "highlight", name: "Highlight" },
  { id: "fade", name: "Fade" },
  { id: "bounce", name: "Bounce" },
  { id: "slide", name: "Slide" },
  { id: "enlarge", name: "Enlarge" },
];

/** What compileCreatomateTimeline.ts actually sets on the Creatomate Text
 * element -- transcriptEffect/transcriptSplit/transcriptColor are real
 * Creatomate properties (verified against the installed SDK source),
 * unlike textTemplates.ts's hand-built canvas renderers. */
export interface TranscriptCaptionConfig {
  transcriptEffect: TranscriptEffect;
  transcriptSplit: Extract<TranscriptSplit, "word" | "line">;
  transcriptColor?: string;
}

const TRANSCRIPT_CAPTION_CONFIGS: Record<TranscriptCaptionTemplateId, TranscriptCaptionConfig> = {
  color: { transcriptEffect: "color", transcriptSplit: "word", transcriptColor: "#60a5fa" },
  karaoke: { transcriptEffect: "karaoke", transcriptSplit: "word", transcriptColor: "#facc15" },
  highlight: { transcriptEffect: "highlight", transcriptSplit: "word", transcriptColor: "#facc15" },
  fade: { transcriptEffect: "fade", transcriptSplit: "line" },
  bounce: { transcriptEffect: "bounce", transcriptSplit: "word" },
  slide: { transcriptEffect: "slide", transcriptSplit: "line" },
  enlarge: { transcriptEffect: "enlarge", transcriptSplit: "word" },
};

/** Boundary-crossing lookup, same reasoning as textTemplates.ts's
 * getTextTemplateRenderer -- a persisted templateId is an untyped string,
 * not guaranteed to still be a known id. */
export function getTranscriptCaptionConfig(templateId: string): TranscriptCaptionConfig {
  return (
    (TRANSCRIPT_CAPTION_CONFIGS as Record<string, TranscriptCaptionConfig>)[templateId] ?? TRANSCRIPT_CAPTION_CONFIGS.color
  );
}

const PLACEHOLDER_WORDS = ["Your", "Words", "Here"];
const ACTIVE_WORD_INDEX = 1;

/** Lays out PLACEHOLDER_WORDS centered on one line at `fontFraction` of
 * rectPx's height, calling `drawWord` for each with its center position --
 * the shared layout every effect except Enlarge (which needs a differently
 * SIZED active word, not just differently styled) uses. */
function drawWordRow(
  ctx: CanvasRenderingContext2D,
  rectPx: TextTemplateRenderContext["rectPx"],
  fontFraction: number,
  fontSpec: (size: number) => string,
  drawWord: (word: string, isActive: boolean, x: number, y: number, fontSize: number) => void
) {
  const fontSize = fontSizeFor(rectPx, fontFraction);
  ctx.font = fontSpec(fontSize);
  const spacing = ctx.measureText(" ").width;
  const wordWidths = PLACEHOLDER_WORDS.map((word) => ctx.measureText(word).width);
  const totalWidth = wordWidths.reduce((sum, w) => sum + w, 0) + spacing * (PLACEHOLDER_WORDS.length - 1);
  const center = rectCenter(rectPx);
  let x = center.x - totalWidth / 2;
  PLACEHOLDER_WORDS.forEach((word, index) => {
    drawWord(word, index === ACTIVE_WORD_INDEX, x + wordWidths[index] / 2, center.y, fontSize);
    x += wordWidths[index] + spacing;
  });
}

const colorRenderer: TextTemplateRenderer = ({ ctx, rectPx }) => {
  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawWordRow(ctx, rectPx, 0.4, fontSpec, (word, isActive, x, y, fontSize) => {
    ctx.font = fontSpec(fontSize);
    ctx.fillStyle = isActive ? "#60a5fa" : "#ffffff";
    ctx.fillText(word, x, y);
  });
  ctx.restore();
};

const karaokeRenderer: TextTemplateRenderer = ({ ctx, rectPx }) => {
  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawWordRow(ctx, rectPx, 0.4, fontSpec, (word, isActive, x, y, fontSize) => {
    ctx.font = fontSpec(fontSize);
    if (isActive) {
      const width = ctx.measureText(word).width;
      ctx.fillStyle = "#facc15";
      ctx.fillRect(x - width / 2, y + fontSize * 0.35, width, fontSize * 0.08);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillText(word, x, y);
  });
  ctx.restore();
};

const highlightRenderer: TextTemplateRenderer = ({ ctx, rectPx }) => {
  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawWordRow(ctx, rectPx, 0.4, fontSpec, (word, isActive, x, y, fontSize) => {
    ctx.font = fontSpec(fontSize);
    if (isActive) {
      const width = ctx.measureText(word).width;
      ctx.fillStyle = "#facc15";
      ctx.beginPath();
      ctx.roundRect(
        x - width / 2 - fontSize * 0.15,
        y - fontSize * 0.55,
        width + fontSize * 0.3,
        fontSize * 1.1,
        fontSize * 0.15
      );
      ctx.fill();
      ctx.fillStyle = "#1c1917";
    } else {
      ctx.fillStyle = "#ffffff";
    }
    ctx.fillText(word, x, y);
  });
  ctx.restore();
};

const fadeRenderer: TextTemplateRenderer = ({ ctx, rectPx }) => {
  const fontSpec = (size: number) => `${size}px sans-serif`;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawWordRow(ctx, rectPx, 0.35, fontSpec, (word, isActive, x, y, fontSize) => {
    ctx.font = fontSpec(fontSize);
    ctx.globalAlpha = isActive ? 1 : 0.35;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(word, x, y);
    ctx.globalAlpha = 1;
  });
  ctx.restore();
};

const bounceRenderer: TextTemplateRenderer = ({ ctx, rectPx }) => {
  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  ctx.save();
  ctx.textAlign = "center";
  drawWordRow(ctx, rectPx, 0.4, fontSpec, (word, isActive, x, y, fontSize) => {
    ctx.save();
    ctx.font = fontSpec(fontSize);
    const scale = isActive ? 1.25 : 1;
    ctx.translate(x, y - (isActive ? fontSize * 0.15 : 0));
    ctx.scale(scale, scale);
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(word, 0, 0);
    ctx.restore();
  });
  ctx.restore();
};

const slideRenderer: TextTemplateRenderer = ({ ctx, rectPx }) => {
  const fontSpec = (size: number) => `${size}px sans-serif`;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawWordRow(ctx, rectPx, 0.35, fontSpec, (word, isActive, x, y, fontSize) => {
    ctx.font = fontSpec(fontSize);
    ctx.globalAlpha = isActive ? 1 : 0.6;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(word, x, isActive ? y : y + fontSize * 0.15);
    ctx.globalAlpha = 1;
  });
  ctx.restore();
};

const enlargeRenderer: TextTemplateRenderer = ({ ctx, rectPx }) => {
  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const center = rectCenter(rectPx);
  const baseFontSize = fontSizeFor(rectPx, 0.35);
  const activeFontSize = fontSizeFor(rectPx, 0.55);
  ctx.font = fontSpec(baseFontSize);
  const spacing = ctx.measureText(" ").width;
  const widths = PLACEHOLDER_WORDS.map((word, index) => {
    ctx.font = fontSpec(index === ACTIVE_WORD_INDEX ? activeFontSize : baseFontSize);
    return ctx.measureText(word).width;
  });
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + spacing * (PLACEHOLDER_WORDS.length - 1);
  let x = center.x - totalWidth / 2;
  PLACEHOLDER_WORDS.forEach((word, index) => {
    const isActive = index === ACTIVE_WORD_INDEX;
    ctx.font = fontSpec(isActive ? activeFontSize : baseFontSize);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(word, x + widths[index] / 2, center.y);
    x += widths[index] + spacing;
  });
  ctx.restore();
};

export const TRANSCRIPT_CAPTION_RENDERERS: Record<TranscriptCaptionTemplateId, TextTemplateRenderer> = {
  color: colorRenderer,
  karaoke: karaokeRenderer,
  highlight: highlightRenderer,
  fade: fadeRenderer,
  bounce: bounceRenderer,
  slide: slideRenderer,
  enlarge: enlargeRenderer,
};

export function getTranscriptCaptionRenderer(templateId: string): TextTemplateRenderer | undefined {
  return (TRANSCRIPT_CAPTION_RENDERERS as Record<string, TextTemplateRenderer>)[templateId];
}
