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
 * style). No text-wrapping/auto-shrink for long strings in v1 -- a string
 * that overflows its rect just overflows.
 */
import { easeInOut } from "./video_math";

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

function rectCenter(rectPx: TextTemplateRenderContext["rectPx"]) {
  return { x: rectPx.x + rectPx.width / 2, y: rectPx.y + rectPx.height / 2 };
}

function fontSizeFor(rectPx: TextTemplateRenderContext["rectPx"], fraction: number): number {
  return Math.max(10, rectPx.height * fraction);
}

/** A brief overshoot/elastic-feeling ease for entrances that should read
 * as a "bounce" rather than a smooth glide -- distinct from video_math.ts's
 * easeInOut, which is used where a plain smooth curve is wanted instead. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const clamped = Math.min(Math.max(t, 0), 1);
  return 1 + c3 * Math.pow(clamped - 1, 3) + c1 * Math.pow(clamped - 1, 2);
}

const boldPop: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const center = rectCenter(rectPx);
  const entrance = easeInOut(Math.min(progress / 0.2, 1));
  const scale = 0.8 + 0.2 * entrance;

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(scale, scale);
  ctx.font = `bold ${fontSizeFor(rectPx, 0.5)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = fontSizeFor(rectPx, 0.5) * 0.12;
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  ctx.strokeText(text, 0, 0);
  ctx.fillText(text, 0, 0);
  ctx.restore();
};

const minimalSubtitle: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  ctx.save();
  ctx.globalAlpha = easeInOut(Math.min(progress / 0.1, 1));

  const barHeight = rectPx.height * 0.7;
  const barY = rectPx.y + rectPx.height - barHeight;
  const radius = barHeight * 0.2;
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.beginPath();
  ctx.roundRect(rectPx.x, barY, rectPx.width, barHeight, radius);
  ctx.fill();

  ctx.font = `${fontSizeFor(rectPx, 0.3)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "white";
  ctx.fillText(text, rectPx.x + rectPx.width / 2, barY + barHeight / 2);
  ctx.restore();
};

const typewriter: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const visibleLength = Math.floor(progress * text.length);
  const visibleText = text.slice(0, visibleLength);

  ctx.save();
  ctx.font = `${fontSizeFor(rectPx, 0.4)}px monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "white";
  ctx.strokeStyle = "black";
  ctx.lineWidth = fontSizeFor(rectPx, 0.4) * 0.08;
  const y = rectPx.y + rectPx.height / 2;
  ctx.strokeText(visibleText, rectPx.x, y);
  ctx.fillText(visibleText, rectPx.x, y);
  ctx.restore();
};

const bounceIn: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const center = rectCenter(rectPx);
  const scale = 0.5 + 0.5 * easeOutBack(Math.min(progress / 0.35, 1));

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(scale, scale);
  ctx.font = `bold ${fontSizeFor(rectPx, 0.5)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = fontSizeFor(rectPx, 0.5) * 0.12;
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";
  ctx.strokeText(text, 0, 0);
  ctx.fillText(text, 0, 0);
  ctx.restore();
};

const highlightBox: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const entrance = easeInOut(Math.min(progress / 0.2, 1));
  const width = rectPx.width * (0.85 + 0.15 * entrance);
  const height = rectPx.height * 0.7;
  const center = rectCenter(rectPx);

  ctx.save();
  ctx.globalAlpha = Math.min(progress / 0.1, 1);
  ctx.fillStyle = "#facc15";
  ctx.beginPath();
  ctx.roundRect(center.x - width / 2, center.y - height / 2, width, height, height * 0.15);
  ctx.fill();

  ctx.font = `bold ${fontSizeFor(rectPx, 0.35)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#1c1917";
  ctx.fillText(text, center.x, center.y);
  ctx.restore();
};

const neonGlow: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const center = rectCenter(rectPx);
  const fontSize = fontSizeFor(rectPx, 0.5);

  ctx.save();
  ctx.globalAlpha = easeInOut(Math.min(progress / 0.15, 1));
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f0abfc";

  // Two passes at different blur radii build up a soft glow rather than
  // one flat blurred edge.
  ctx.shadowColor = "#e879f9";
  ctx.shadowBlur = fontSize * 0.6;
  ctx.fillText(text, center.x, center.y);
  ctx.shadowBlur = fontSize * 0.25;
  ctx.fillText(text, center.x, center.y);
  ctx.restore();
};

const wordPop: TextTemplateRenderer = ({ ctx, text, rectPx, progress }) => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return;

  ctx.save();
  ctx.font = `bold ${fontSizeFor(rectPx, 0.4)}px sans-serif`;
  ctx.textBaseline = "middle";
  const spacing = ctx.measureText(" ").width;
  const wordWidths = words.map((word) => ctx.measureText(word).width);
  const totalWidth = wordWidths.reduce((sum, w) => sum + w, 0) + spacing * (words.length - 1);

  let x = rectPx.x + rectPx.width / 2 - totalWidth / 2;
  const y = rectPx.y + rectPx.height / 2;

  words.forEach((word, index) => {
    const wordProgress = Math.min(Math.max(progress * words.length - index, 0), 1);
    const eased = easeInOut(wordProgress);
    ctx.save();
    ctx.globalAlpha = eased;
    ctx.translate(x + wordWidths[index] / 2, y);
    ctx.scale(0.7 + 0.3 * eased, 0.7 + 0.3 * eased);
    ctx.textAlign = "center";
    ctx.fillStyle = "white";
    ctx.strokeStyle = "black";
    ctx.lineWidth = fontSizeFor(rectPx, 0.4) * 0.08;
    ctx.strokeText(word, 0, 0);
    ctx.fillText(word, 0, 0);
    ctx.restore();
    x += wordWidths[index] + spacing;
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
  return (TEXT_TEMPLATE_RENDERERS as Record<string, TextTemplateRenderer>)[templateId];
}
