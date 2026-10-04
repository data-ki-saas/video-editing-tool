/**
 * Canvas renderer for "headline" labels -- big, background-less animated text
 * (see the `headline` field on LabelSpec in labelTemplates.ts). Unlike the
 * pill/capsule labels, nothing is drawn behind the text: it's just large bold
 * letters (optionally outlined or glowing) over the footage, with an entrance
 * animation driven by the overlay's 0..1 progress.
 *
 * Size comes from the overlay rect's HEIGHT (text wraps and shrinks to fit the
 * rect, same as every other text template via fitTextToRect).
 */
import { easeInOut } from "./video_math";
import { fitTextToRect } from "./textTemplates";

export type HeadlineAnimation =
  | "pop"
  | "slide-up"
  | "typewriter"
  | "word-stagger"
  | "letter-wave"
  | "zoom-drift"
  | "glow-pulse";

export interface HeadlineStyle {
  animation: HeadlineAnimation;
  /** Outline colour, or null for none. */
  stroke: string | null;
  /** Glow colour, or null for a plain soft drop shadow. */
  glow: string | null;
}

/** Base font size as a fraction of the rect's height. */
export const HEADLINE_FONT_FRACTION = 0.7;
/** Outline width, in ems of the font size. */
export const HEADLINE_STROKE_EM = 0.1;

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp01(t);
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export function drawHeadline(
  style: HeadlineStyle,
  fill: string,
  ctx: CanvasRenderingContext2D,
  text: string,
  rectPx: { x: number; y: number; width: number; height: number },
  progress: number
) {
  const value = text.trim();
  if (!value) return;

  const fontSpec = (size: number) => `bold ${size}px sans-serif`;
  // Leave headroom for scale-ups (pop overshoot, zoom-drift).
  const layout = fitTextToRect(
    ctx,
    value,
    rectPx.width * 0.9,
    rectPx.height * 0.9,
    rectPx.height * HEADLINE_FONT_FRACTION,
    fontSpec
  );
  const fontSize = layout.fontSize;
  const lineHeight = layout.lineHeightPx;
  const cx = rectPx.x + rectPx.width / 2;
  const cy = rectPx.y + rectPx.height / 2;
  const firstLineY = cy - (layout.lines.length * lineHeight) / 2 + lineHeight / 2;
  const lineY = (i: number) => firstLineY + i * lineHeight;

  const p = clamp01(progress);
  const exit = easeInOut(Math.min((1 - p) / 0.12, 1));

  ctx.save();
  ctx.font = fontSpec(fontSize);
  ctx.textBaseline = "middle";
  ctx.fillStyle = fill;
  ctx.lineJoin = "round";
  ctx.lineWidth = fontSize * HEADLINE_STROKE_EM;
  if (style.stroke) ctx.strokeStyle = style.stroke;

  const setShadow = (blurEm: number) => {
    if (style.glow) {
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = fontSize * blurEm;
      ctx.shadowOffsetY = 0;
    } else {
      ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
      ctx.shadowBlur = fontSize * 0.08;
      ctx.shadowOffsetY = fontSize * 0.04;
    }
  };
  setShadow(0.5);

  const paint = (s: string, x: number, y: number) => {
    if (style.stroke) ctx.strokeText(s, x, y);
    ctx.fillText(s, x, y);
  };
  const paintCentered = () => {
    ctx.textAlign = "center";
    layout.lines.forEach((line, i) => paint(line, cx, lineY(i)));
  };

  switch (style.animation) {
    case "pop": {
      const t = clamp01(p / 0.3);
      ctx.globalAlpha = Math.min(easeInOut(clamp01(p / 0.1)), exit);
      ctx.translate(cx, cy);
      ctx.scale(0.3 + 0.7 * easeOutBack(t), 0.3 + 0.7 * easeOutBack(t));
      ctx.translate(-cx, -cy);
      paintCentered();
      break;
    }
    case "slide-up": {
      const e = easeInOut(clamp01(p / 0.3));
      ctx.globalAlpha = Math.min(e, exit);
      ctx.translate(0, (1 - e) * fontSize * 0.8);
      paintCentered();
      break;
    }
    case "zoom-drift": {
      ctx.globalAlpha = Math.min(easeInOut(clamp01(p / 0.12)), exit);
      const s = 1 + 0.12 * p;
      ctx.translate(cx, cy);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
      paintCentered();
      break;
    }
    case "glow-pulse": {
      ctx.globalAlpha = Math.min(easeInOut(clamp01(p / 0.15)), exit);
      setShadow(0.35 + 0.3 * (0.5 + 0.5 * Math.sin(p * Math.PI * 12)));
      paintCentered();
      break;
    }
    case "typewriter": {
      ctx.globalAlpha = exit;
      ctx.textAlign = "left";
      const totalChars = layout.lines.reduce((sum, line) => sum + line.length, 0);
      let budget = Math.floor(clamp01(p / 0.6) * totalChars);
      layout.lines.forEach((line, i) => {
        // Position from the FULL line so text doesn't shift as it types.
        const x0 = cx - ctx.measureText(line).width / 2;
        const shown = line.slice(0, Math.min(Math.max(budget, 0), line.length));
        const typingHere = budget >= 0 && budget < line.length;
        budget -= line.length;
        if (shown) paint(shown, x0, lineY(i));
        if (typingHere || (i === layout.lines.length - 1 && budget >= 0 && p < 0.95)) {
          if (Math.floor(p * 40) % 2 === 0) {
            const caretX = x0 + ctx.measureText(shown).width + fontSize * 0.06;
            ctx.fillRect(caretX, lineY(i) - fontSize * 0.45, fontSize * 0.07, fontSize * 0.9);
          }
        }
      });
      break;
    }
    case "word-stagger": {
      ctx.textAlign = "left";
      const spacing = ctx.measureText(" ").width;
      const total = layout.lineWords.reduce((sum, words) => sum + words.length, 0);
      let index = 0;
      layout.lineWords.forEach((words, i) => {
        const widths = words.map((w) => ctx.measureText(w).width);
        const lineWidth = widths.reduce((a, b) => a + b, 0) + spacing * (words.length - 1);
        let x = cx - lineWidth / 2;
        words.forEach((word, w) => {
          const start = (index / Math.max(total, 1)) * 0.5;
          const t = easeInOut(clamp01((p - start) / 0.15));
          ctx.save();
          ctx.globalAlpha = Math.min(t, exit);
          paint(word, x, lineY(i) + (1 - t) * fontSize * 0.6);
          ctx.restore();
          x += widths[w] + spacing;
          index += 1;
        });
      });
      break;
    }
    case "letter-wave": {
      ctx.textAlign = "left";
      const total = layout.lines.reduce((sum, line) => sum + line.length, 0);
      let index = 0;
      layout.lines.forEach((line, i) => {
        const x0 = cx - ctx.measureText(line).width / 2;
        for (let c = 0; c < line.length; c += 1) {
          const start = (index / Math.max(total, 1)) * 0.45;
          const t = clamp01((p - start) / 0.12);
          const drop = -(1 - easeOutBack(t)) * fontSize * 0.9;
          const idle = Math.sin(p * Math.PI * 10 + index * 0.5) * fontSize * 0.04 * t;
          const x = x0 + ctx.measureText(line.slice(0, c)).width;
          ctx.save();
          ctx.globalAlpha = Math.min(t * 2, 1) * exit;
          paint(line[c], x, lineY(i) + drop + idle);
          ctx.restore();
          index += 1;
        }
      });
      break;
    }
  }
  ctx.restore();
}
