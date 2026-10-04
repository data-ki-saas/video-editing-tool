/**
 * The "Label" catalog -- pill / capsule / rectangular tags such as a price
 * on a blue chip next to a name on white, or a title stacked over a
 * description. A label is stored as an ordinary TextOverlay (video_math.ts)
 * whose templateId is `label:<spec id>` and whose `text` holds one string
 * per part joined by "\n" (see encodeLabelText), so playback
 * (CanvasPlayer), export (exportTimeline) and the active-frame preview
 * (FrameStrip's TextOverlayCanvas) all draw it through the same
 * getTextTemplateRenderer lookup every other text template uses -- see
 * textTemplates.ts, which delegates any `label:` id here.
 *
 * Each LabelSpec is plain data (colours, shape, layout) shared by TWO views
 * of the same label: drawLabel below (canvas, used by playback/export and the
 * on-frame preview) and LabelDialog's LabelView (CSS, so text can be typed
 * in place). Both derive their geometry from the same em-based metrics
 * constants below, so a label looks the same in the picker as on the video.
 *
 * Unlike the plain text templates, a label hugs its text: the overlay's
 * `rect` is the label's bounding box -- its HEIGHT sets the label's size, its
 * WIDTH is only a cap -- and the label is drawn centred in it at whatever
 * width its text needs, shrinking uniformly if the text would overflow.
 */
import { easeInOut, type CropRect, type TextOverlay } from "./video_math";

export const LABEL_TEMPLATE_PREFIX = "label:";

export function isLabelTemplateId(templateId: string): boolean {
  return templateId.startsWith(LABEL_TEMPLATE_PREFIX);
}

export type LabelLayout =
  /** One part. */
  | "single"
  /** Two parts side by side (price | name). */
  | "split"
  /** Two parts stacked (title over description). */
  | "stacked";

export type LabelCorners = "full" | "round" | "square";

export interface LabelPartSpec {
  bg: string;
  fg: string;
  placeholder: string;
  /** Font size relative to the label's base size. */
  scale: number;
  bold: boolean;
}

export interface LabelSpec {
  id: string;
  name: string;
  layout: LabelLayout;
  corners: LabelCorners;
  parts: LabelPartSpec[];
}

const part = (bg: string, fg: string, placeholder: string, scale = 1, bold = true): LabelPartSpec => ({
  bg,
  fg,
  placeholder,
  scale,
  bold,
});

// Palette kept to a handful of colours that stay legible over any footage.
const BLUE = "#2563eb";
const RED = "#dc2626";
const GREEN = "#16a34a";
const YELLOW = "#facc15";
const INK = "#111827";
const WHITE = "#ffffff";

export const LABEL_SPECS: LabelSpec[] = [
  { id: "pill-dark", name: "Pill", layout: "single", corners: "full", parts: [part(INK, WHITE, "Your text")] },
  { id: "pill-yellow", name: "Pill · Yellow", layout: "single", corners: "full", parts: [part(YELLOW, INK, "Your text")] },
  { id: "pill-red", name: "Pill · Red", layout: "single", corners: "full", parts: [part(RED, WHITE, "Your text")] },
  { id: "pill-white", name: "Pill · White", layout: "single", corners: "full", parts: [part(WHITE, INK, "Your text")] },
  {
    id: "capsule-blue",
    name: "Capsule · Blue",
    layout: "split",
    corners: "full",
    parts: [part(BLUE, WHITE, "₹99"), part(WHITE, INK, "Name")],
  },
  {
    id: "capsule-red",
    name: "Capsule · Red",
    layout: "split",
    corners: "full",
    parts: [part(RED, WHITE, "₹99"), part(WHITE, INK, "Name")],
  },
  {
    id: "capsule-green",
    name: "Capsule · Green",
    layout: "split",
    corners: "full",
    parts: [part(GREEN, WHITE, "₹99"), part(WHITE, INK, "Name")],
  },
  {
    id: "capsule-dark",
    name: "Capsule · Dark",
    layout: "split",
    corners: "full",
    parts: [part(YELLOW, INK, "₹99"), part(INK, WHITE, "Name")],
  },
  { id: "rect-solid", name: "Rectangle", layout: "single", corners: "square", parts: [part(BLUE, WHITE, "Your text")] },
  {
    id: "rect-blue",
    name: "Rectangle · Blue",
    layout: "split",
    corners: "square",
    parts: [part(BLUE, WHITE, "₹99"), part(WHITE, INK, "Name")],
  },
  {
    id: "rect-dark",
    name: "Rectangle · Dark",
    layout: "split",
    corners: "round",
    parts: [part(YELLOW, INK, "₹99"), part(INK, WHITE, "Name")],
  },
  {
    id: "stack-blue",
    name: "Title · Blue",
    layout: "stacked",
    corners: "round",
    parts: [part(BLUE, WHITE, "Title"), part(WHITE, INK, "Description", 0.72, false)],
  },
  {
    id: "stack-dark",
    name: "Title · Dark",
    layout: "stacked",
    corners: "square",
    parts: [part(INK, WHITE, "Title"), part(YELLOW, INK, "Description", 0.72, false)],
  },
  {
    id: "stack-red",
    name: "Title · Red",
    layout: "stacked",
    corners: "round",
    parts: [part(RED, WHITE, "Title"), part(WHITE, INK, "Description", 0.72, false)],
  },
];

export function labelTemplateId(specId: string): string {
  return `${LABEL_TEMPLATE_PREFIX}${specId}`;
}

export function getLabelSpec(templateId: string): LabelSpec | undefined {
  if (!isLabelTemplateId(templateId)) return undefined;
  const specId = templateId.slice(LABEL_TEMPLATE_PREFIX.length);
  return LABEL_SPECS.find((spec) => spec.id === specId);
}

/** A label's parts live in TextOverlay.text joined by "\n" -- parts are
 * single-line inputs, so a newline can never occur inside one. */
export function encodeLabelText(parts: string[]): string {
  return parts.join("\n");
}

export function decodeLabelText(text: string, partCount: number): string[] {
  const pieces = text.split("\n");
  return Array.from({ length: partCount }, (_, index) => pieces[index] ?? "");
}

/** What a label shows for its saved text -- parts joined with a separator,
 * for the track segment's tooltip and the "what's on this reel" summary. */
export function describeLabelText(text: string): string {
  return text
    .split("\n")
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join(" · ");
}

// Default bounding box for a fresh label: the lower third, where captions
// conventionally sit. Height = label size (see this file's module comment).
export const DEFAULT_LABEL_RECT: CropRect = { x: 0.05, y: 0.74, width: 0.9, height: 0.07 };
export const DEFAULT_STACKED_LABEL_RECT: CropRect = { x: 0.05, y: 0.7, width: 0.9, height: 0.12 };

export function defaultLabelRect(spec: LabelSpec): CropRect {
  return spec.layout === "stacked" ? DEFAULT_STACKED_LABEL_RECT : DEFAULT_LABEL_RECT;
}

// ---- shared em-based metrics (CSS view and canvas view both use these) ----

/** Horizontal / vertical padding and line height of a part, in ems of that
 * part's OWN font size. */
export const LABEL_PAD_X_EM = 0.85;
export const LABEL_PAD_Y_EM = 0.4;
export const LABEL_LINE_EM = 1.2;
export const LABEL_PART_HEIGHT_EM = LABEL_LINE_EM + LABEL_PAD_Y_EM * 2;
/** Corner radius for "round" labels, in ems of the base font size. */
export const LABEL_ROUND_RADIUS_EM = 0.45;

/** Total label height in ems of the base font size, for the parts actually
 * shown in the given layout. */
export function labelHeightEm(layout: LabelLayout, parts: LabelPartSpec[]): number {
  if (layout === "stacked") return parts.reduce((sum, p) => sum + p.scale * LABEL_PART_HEIGHT_EM, 0);
  return LABEL_PART_HEIGHT_EM * Math.max(...parts.map((p) => p.scale));
}

function fontSpec(partSpec: LabelPartSpec, sizePx: number): string {
  return `${partSpec.bold ? "bold " : ""}${sizePx}px sans-serif`;
}

/** Draws one label centred in `rectPx`. `text` carries one "\n"-joined
 * string per part; a blank part is simply omitted (the rest of the label
 * closes up around it) rather than drawn as an empty box. */
export function drawLabel(
  spec: LabelSpec,
  ctx: CanvasRenderingContext2D,
  text: string,
  rectPx: { x: number; y: number; width: number; height: number },
  progress: number
) {
  const pieces = decodeLabelText(text, spec.parts.length);
  const shown = spec.parts
    .map((partSpec, index) => ({ partSpec, value: pieces[index].trim() }))
    .filter((entry) => entry.value.length > 0);
  if (shown.length === 0) return;

  // A label with a part left blank behaves as a smaller layout: a split
  // with one side blank is just a single chip, a stacked one with no
  // description is just the title.
  const layout: LabelLayout = shown.length === 1 ? "single" : spec.layout;
  const heightEm = labelHeightEm(
    layout,
    shown.map((e) => e.partSpec)
  );

  // Lay everything out at a reference size, then scale: widths are linear in
  // font size, so one measurement pass covers any final size.
  const REF = 100;
  const textWidthRef = shown.map((e) => {
    ctx.font = fontSpec(e.partSpec, REF * e.partSpec.scale);
    return ctx.measureText(e.value).width;
  });
  const boxWidthRef = shown.map((e, i) => textWidthRef[i] + 2 * LABEL_PAD_X_EM * REF * e.partSpec.scale);
  const naturalWidthRef = layout === "split" ? boxWidthRef.reduce((a, b) => a + b, 0) : Math.max(...boxWidthRef);

  // Height sets the size; width only caps it (uniform shrink on overflow).
  let fontSize = rectPx.height / heightEm;
  if ((naturalWidthRef / REF) * fontSize > rectPx.width) fontSize = (rectPx.width * REF) / naturalWidthRef;
  const k = fontSize / REF;

  const totalWidth = naturalWidthRef * k;
  const totalHeight = heightEm * fontSize;
  const left = rectPx.x + (rectPx.width - totalWidth) / 2;
  const top = rectPx.y + (rectPx.height - totalHeight) / 2;

  const radius =
    spec.corners === "full" ? totalHeight / 2 : spec.corners === "round" ? LABEL_ROUND_RADIUS_EM * fontSize : 0;
  // A "full" stacked label would be a lozenge too tall to read as one --
  // the catalog avoids it, but clamp anyway so a bad spec can't draw one.
  const clampedRadius = Math.min(radius, totalWidth / 2, totalHeight / 2);

  const fadeIn = easeInOut(Math.min(progress / 0.12, 1));
  const fadeOut = easeInOut(Math.min((1 - progress) / 0.1, 1));
  const alpha = Math.min(fadeIn, fadeOut);
  const scale = 0.92 + 0.08 * fadeIn;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(left + totalWidth / 2, top + totalHeight / 2);
  ctx.scale(scale, scale);
  ctx.translate(-totalWidth / 2, -totalHeight / 2);

  let offset = 0;
  const partRects = shown.map((e, i) => {
    const partHeight = e.partSpec.scale * LABEL_PART_HEIGHT_EM * fontSize;
    const rect =
      layout === "split"
        ? { x: offset, y: 0, width: boxWidthRef[i] * k, height: totalHeight }
        : { x: 0, y: offset, width: totalWidth, height: partHeight };
    offset += layout === "split" ? rect.width : partHeight;
    return rect;
  });

  // Each part is its own path, rounded only at the label's outer corners --
  // not a clip over one backing shape, whose antialiased edge lets the
  // backing colour show as a hairline beside a differently-coloured part.
  // Drawn twice: the first pass casts the drop shadow, the second (no
  // shadow) covers any shadow that bled across the seam between parts.
  const last = shown.length - 1;
  const partRadii = (i: number): number[] => {
    const r = clampedRadius;
    if (shown.length === 1) return [r, r, r, r];
    if (layout === "split") return i === 0 ? [r, 0, 0, r] : i === last ? [0, r, r, 0] : [0, 0, 0, 0];
    return i === 0 ? [r, r, 0, 0] : i === last ? [0, 0, r, r] : [0, 0, 0, 0];
  };
  for (const castShadow of [true, false]) {
    ctx.shadowColor = castShadow ? "rgba(0, 0, 0, 0.35)" : "transparent";
    ctx.shadowBlur = castShadow ? fontSize * 0.3 : 0;
    ctx.shadowOffsetY = castShadow ? fontSize * 0.1 : 0;
    shown.forEach((e, i) => {
      ctx.fillStyle = e.partSpec.bg;
      ctx.beginPath();
      ctx.roundRect(partRects[i].x, partRects[i].y, partRects[i].width, partRects[i].height, partRadii(i));
      ctx.fill();
    });
  }
  ctx.shadowColor = "transparent";

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  shown.forEach((e, i) => {
    ctx.font = fontSpec(e.partSpec, fontSize * e.partSpec.scale);
    ctx.fillStyle = e.partSpec.fg;
    ctx.fillText(e.value, partRects[i].x + partRects[i].width / 2, partRects[i].y + partRects[i].height / 2);
  });
  ctx.restore();
}

// ---- single-row track geometry (labels never overlap one another) ----

/** Shortest a label may be shown for. */
export const MIN_LABEL_DURATION_SECONDS = 0.5;
export const DEFAULT_LABEL_DURATION_SECONDS = 3;

/** The free stretch of time around [start, end] -- bounded by the nearest
 * other label before and after it (or the reel's own edges). `selfIndex`
 * is the overlay being moved/resized (index into `overlays`, which holds
 * every text overlay, not just labels); null when placing a new one. */
export function computeLabelGapBounds(
  overlays: TextOverlay[],
  selfIndex: number | null,
  startSeconds: number,
  endSeconds: number,
  totalSeconds: number
): { min: number; max: number } {
  let min = 0;
  let max = totalSeconds;
  overlays.forEach((overlay, index) => {
    if (index === selfIndex || !isLabelTemplateId(overlay.templateId)) return;
    if (overlay.endTimeSeconds <= startSeconds + 1e-6) min = Math.max(min, overlay.endTimeSeconds);
    else if (overlay.startTimeSeconds >= endSeconds - 1e-6) max = Math.min(max, overlay.startTimeSeconds);
  });
  return { min, max };
}

/** Where a brand-new label can go: as close to `desiredStart` as possible,
 * and as close to `desiredDuration` long as the gap allows (never shorter
 * than the minimum). Null when every stretch of the reel is already taken. */
export function findFreeLabelSlot(
  overlays: TextOverlay[],
  desiredStart: number,
  desiredDuration: number,
  totalSeconds: number
): { start: number; end: number } | null {
  const labels = overlays
    .filter((overlay) => isLabelTemplateId(overlay.templateId))
    .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  // Free gaps between labels, in order.
  const gaps: { min: number; max: number }[] = [];
  let cursor = 0;
  for (const label of labels) {
    if (label.startTimeSeconds > cursor) gaps.push({ min: cursor, max: label.startTimeSeconds });
    cursor = Math.max(cursor, label.endTimeSeconds);
  }
  if (cursor < totalSeconds) gaps.push({ min: cursor, max: totalSeconds });

  const usable = gaps.filter((gap) => gap.max - gap.min >= MIN_LABEL_DURATION_SECONDS);
  if (usable.length === 0) return null;

  // Prefer the gap holding the playhead, else the nearest one after it,
  // else the last one before it.
  const chosen =
    usable.find((gap) => desiredStart >= gap.min && desiredStart < gap.max) ??
    usable.find((gap) => gap.min >= desiredStart) ??
    usable[usable.length - 1];
  const start = Math.min(Math.max(desiredStart, chosen.min), chosen.max - MIN_LABEL_DURATION_SECONDS);
  const end = Math.min(start + desiredDuration, chosen.max);
  return { start, end };
}
