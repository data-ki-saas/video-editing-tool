"use client";

/**
 * "Real poses" tab of the Peeps picker -- the hand-drawn Open Peeps pack by Pablo
 * Stanley (public/peeps-coloured/, built by scripts/build-peeps-plus.mjs).
 *
 * Two modes: "Poses" mixes one of the pack's real body poses (pointing, crossed
 * arms, walking, sitting, ...) with any head, face, beard and glasses; "Ready-made"
 * drops in one of the pack's finished figures as-is. Placed like any prop:
 * rasterized to a transparent, tightly cropped PNG and uploaded as an image overlay.
 *
 * The pack's loose parts are drawn 4.2x larger than its templates; every template
 * of one stance (standing / sitting) uses the same offsets, so any head fits any
 * pose and we compose them with the manifest's layout numbers.
 */
import { useEffect, useMemo, useState } from "react";

const BASE = "/peeps-coloured/";
const RASTER_MAX_SIDE = 2400;
const ALPHA_VISIBLE_THRESHOLD = 16;
const CROP_PAD = 0.06; // breathing room around a composed figure, as a fraction of its size

type Stance = "standing" | "sitting";
type Rect = [number, number, number, number];

interface Part {
  id: string;
  label: string;
  file: string;
  bbox?: Rect;
}

interface Layout {
  pose: [number, number];
  head: [number, number];
  face: [number, number];
  facialHair: [number, number];
  accessory: [number, number];
}

interface Manifest {
  scale: number;
  layouts: Record<Stance, Layout>;
  poses: Record<Stance, Part[]>;
  heads: Part[];
  faces: Part[];
  facialHair: Part[];
  accessories: Part[];
  templates: Record<"bust" | "standing" | "sitting" | "masks", string[]>;
}

const fileCache = new Map<string, Promise<string>>();
function loadText(file: string): Promise<string> {
  let cached = fileCache.get(file);
  if (!cached) {
    cached = fetch(BASE + file).then((res) => {
      if (!res.ok) throw new Error(`Could not load ${file}`);
      return res.text();
    });
    cached.catch(() => fileCache.delete(file));
    fileCache.set(file, cached);
  }
  return cached;
}

let manifestPromise: Promise<Manifest> | null = null;
function loadManifest(): Promise<Manifest> {
  if (!manifestPromise) {
    manifestPromise = fetch(`${BASE}manifest.json`).then((res) => {
      if (!res.ok) throw new Error("Could not load the Peeps pack");
      return res.json() as Promise<Manifest>;
    });
    manifestPromise.catch(() => (manifestPromise = null));
  }
  return manifestPromise;
}

const innerMarkup = (svg: string) =>
  svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<title>[\s\S]*?<\/title>|<desc>[\s\S]*?<\/desc>/g, "");

export interface Look {
  stance: Stance;
  pose: string;
  head: string;
  face: string;
  beard: string | null;
  glasses: string | null;
  flip: boolean;
}

/** What is stored on a placed figure so it can be edited again (`kind` tells it apart from a builder peep). */
export interface PackPeep {
  kind: "pack";
  look: Look;
  fills: Fill[];
}

export function isPackPeep(peep: Record<string, unknown>): peep is Record<string, unknown> & PackPeep {
  return peep.kind === "pack" && typeof peep.look === "object" && peep.look !== null;
}

type Texts = Record<string, string>; // part file -> svg text

function find(list: Part[], id: string | null): Part | null {
  return id ? (list.find((p) => p.id === id) ?? null) : null;
}

/** The figure as an SVG document, plus its framing in template units. */
function composeFigure(m: Manifest, texts: Texts, look: Look, parts: "all" | "head" = "all"): { svg: string; box: Rect } | null {
  const layout = m.layouts[look.stance];
  const pose = find(m.poses[look.stance], look.pose);
  const head = find(m.heads, look.head);
  const face = find(m.faces, look.face);
  const beard = find(m.facialHair, look.beard);
  const glasses = find(m.accessories, look.glasses);
  if (!head || (parts === "all" && !pose)) return null;
  const k = m.scale;
  const layer = (part: Part | null, at: [number, number]) =>
    part && texts[part.file] ? `<g transform="translate(${at[0]} ${at[1]}) scale(${k})">${innerMarkup(texts[part.file])}</g>` : "";
  const headAt = layout.head;
  const at = (offset: [number, number]): [number, number] => [headAt[0] + offset[0], headAt[1] + offset[1]];
  const body =
    (parts === "all" ? layer(pose, layout.pose) : "") +
    layer(head, headAt) +
    layer(face, at(layout.face)) +
    layer(beard, at(layout.facialHair)) +
    layer(glasses, at(layout.accessory));

  const rects: Rect[] = [[headAt[0] + head.bbox![0] * k, headAt[1] + head.bbox![1] * k, head.bbox![2] * k, head.bbox![3] * k]];
  if (parts === "all" && pose?.bbox) rects.push([layout.pose[0] + pose.bbox[0] * k, layout.pose[1] + pose.bbox[1] * k, pose.bbox[2] * k, pose.bbox[3] * k]);
  const x0 = Math.min(...rects.map((r) => r[0]));
  const y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[0] + r[2]));
  const y1 = Math.max(...rects.map((r) => r[1] + r[3]));
  const padX = (x1 - x0) * CROP_PAD;
  const padY = (y1 - y0) * CROP_PAD;
  const box: Rect = [x0 - padX, y0 - padY, x1 - x0 + 2 * padX, y1 - y0 + 2 * padY];
  const flipped = look.flip ? `<g transform="translate(${2 * box[0] + box[2]} 0) scale(-1 1)">${body}</g>` : body;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.join(" ")}">${flipped}</svg>`;
  return { svg, box };
}

const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// --- Painting -----------------------------------------------------------------
// The pack is black and white: every shape is a white "background" fill under black
// ink lines, and a whole figure's fills are only one or two shapes, so skin, clothes
// and hair can't be told apart in the files. The ink lines do divide the figure into
// regions on screen though, so painting is a bucket fill: click a region and it takes
// the colour. A fill is remembered as a click position (so it replays at any size),
// and the colour is laid *under* the ink so the lines stay crisp.
const INK_BARRIER = 128; // ink alpha at or above this stops a fill
const SHAPE_MIN_ALPHA = 8;

export interface Fill {
  x: number; // 0..1 across the figure's frame
  y: number;
  color: string;
}

/** The same figure twice: only the white fills, and only the black ink lines. */
function splitLayers(svg: string): { fill: string; ink: string } {
  return {
    fill: svg.replace(/(id="🖍-Ink"[^>]*?)fill="[^"]*"/g, '$1fill="none"'),
    ink: svg.replace(/(id="🎨-Background"[^>]*?)fill="[^"]*"/g, '$1fill="none"'),
  };
}

async function drawSvg(svg: string, w: number, h: number): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = svgDataUrl(svg.replace(/^<svg /, `<svg width="${w}" height="${h}" `));
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not draw this figure");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Pixels connected to (sx, sy) that are inside the figure's fill and not on an ink line. */
function floodRegion(fillData: Uint8ClampedArray, inkData: Uint8ClampedArray, w: number, h: number, sx: number, sy: number): Uint8Array | null {
  const open = (i: number) => fillData[i * 4 + 3] > SHAPE_MIN_ALPHA && inkData[i * 4 + 3] < INK_BARRIER;
  const start = sy * w + sx;
  if (!open(start)) return null;
  const mask = new Uint8Array(w * h);
  const stack = [start];
  mask[start] = 1;
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = i % w;
    const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1];
    for (const n of neighbours) {
      if (n >= 0 && !mask[n] && open(n)) {
        mask[n] = 1;
        stack.push(n);
      }
    }
  }
  return mask;
}

/** Grows a mask by `r` pixels, so a fill tucks under the ink lines that bound it. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const horizontal = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dx = Math.max(0, x - r); dx <= Math.min(w - 1, x + r); dx++) horizontal[y * w + dx] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!horizontal[y * w + x]) continue;
      for (let dy = Math.max(0, y - r); dy <= Math.min(h - 1, y + r); dy++) out[dy * w + x] = 1;
    }
  }
  return out;
}

/** The figure drawn at `width` px wide with every fill applied, ink on top. */
async function paintFigure(svg: string, box: Rect, fills: Fill[], width: number): Promise<HTMLCanvasElement> {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round((width * box[3]) / box[2]));
  const layers = splitLayers(svg);
  const [fillCanvas, inkCanvas] = await Promise.all([drawSvg(layers.fill, w, h), drawSvg(layers.ink, w, h)]);
  const fillImage = fillCanvas.getContext("2d")!.getImageData(0, 0, w, h);
  const inkData = inkCanvas.getContext("2d")!.getImageData(0, 0, w, h).data;
  const radius = Math.max(1, Math.round(w / 250));
  for (const fill of fills) {
    const region = floodRegion(fillImage.data, inkData, w, h, Math.min(w - 1, Math.max(0, Math.round(fill.x * w))), Math.min(h - 1, Math.max(0, Math.round(fill.y * h))));
    if (!region) continue;
    const grown = dilate(region, w, h, radius);
    const [r, g, b] = hexToRgb(fill.color);
    for (let i = 0; i < grown.length; i++) {
      if (grown[i] && fillImage.data[i * 4 + 3] > SHAPE_MIN_ALPHA) {
        fillImage.data[i * 4] = r;
        fillImage.data[i * 4 + 1] = g;
        fillImage.data[i * 4 + 2] = b;
      }
    }
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.putImageData(fillImage, 0, 0);
  ctx.drawImage(inkCanvas, 0, 0);
  return out;
}

/** Transparent PNG of a canvas, cropped to its visible pixels, plus the crop's aspect ratio. */
async function cropToPng(canvas: HTMLCanvasElement): Promise<{ file: File; aspect: number }> {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not draw this figure");
  const { data } = ctx.getImageData(0, 0, w, h);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > ALPHA_VISIBLE_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("Could not draw this figure");
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const cropped = document.createElement("canvas");
  cropped.width = cw;
  cropped.height = ch;
  cropped.getContext("2d")?.drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
  const blob = await new Promise<Blob | null>((resolve) => cropped.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not draw this figure");
  return { file: new File([blob], "peep-pack.png", { type: "image/png" }), aspect: cw / ch };
}

/** Transparent, cropped PNG of an SVG document (painted with `fills`, if any). */
async function rasterizeCropped(svg: string, width: number, height: number, fills: Fill[] = []): Promise<{ file: File; aspect: number }> {
  const scale = RASTER_MAX_SIDE / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = fills.length > 0 ? await paintFigure(svg, [0, 0, width, height], fills, w) : await drawSvg(svg, w, h);
  return cropToPng(canvas);
}

const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundColor: "#e5e5e5",
  backgroundImage:
    "linear-gradient(45deg, #cfcfcf 25%, transparent 25%, transparent 75%, #cfcfcf 75%), linear-gradient(45deg, #cfcfcf 25%, transparent 25%, transparent 75%, #cfcfcf 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
};

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

type PartKey = "pose" | "head" | "face" | "beard" | "glasses";
const PART_LABELS: Record<PartKey, string> = { pose: "Pose", head: "Hair & head", face: "Face", beard: "Beard", glasses: "Glasses" };

function randomLook(m: Manifest, stance: Stance): Look {
  return {
    stance,
    pose: pick(m.poses[stance]).id,
    head: pick(m.heads).id,
    face: pick(m.faces).id,
    beard: Math.random() < 0.2 ? pick(m.facialHair).id : null,
    glasses: Math.random() < 0.25 ? pick(m.accessories).id : null,
    flip: false,
  };
}

// Skin tones first, then hair / clothes colours.
const PAINT_SWATCHES = ["#f5d5b8", "#e0a37a", "#c68642", "#8d5524", "#4a312c", "#111111", "#ffffff", "#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];
const PREVIEW_WIDTH = 480;
const MAX_FILLS = 100;

type Mode = "poses" | "ready";
type ReadyKey = keyof Manifest["templates"];
const READY_LABELS: Record<ReadyKey, string> = { bust: "Bust", standing: "Standing", sitting: "Sitting", masks: "With masks" };

export function PeepsPlusTab({
  placingKey,
  onPlace,
  initialPeep,
  submitLabel = "Add to reel",
}: {
  placingKey: string | null;
  // `aspect` is the cropped artwork's width/height, so it is placed unsquashed.
  // `peep` is this figure's settings, stored on the overlay so it can be edited again.
  // Ready-made figures carry no settings (they are not editable), so `peep` is absent for them.
  onPlace: (file: File, key: string, aspect: number, peep?: PackPeep) => void;
  // Reopen an existing figure (from an overlay's stored settings) instead of a random one.
  initialPeep?: PackPeep;
  submitLabel?: string;
}) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [texts, setTexts] = useState<Texts>({});
  const [look, setLook] = useState<Look | null>(null);
  const [mode, setMode] = useState<Mode>("poses");
  const [activePart, setActivePart] = useState<PartKey>("pose");
  const [ready, setReady] = useState<ReadyKey>("standing");
  const [error, setError] = useState<string | null>(null);
  const [fills, setFills] = useState<Fill[]>(initialPeep?.fills ?? []);
  const [paintColor, setPaintColor] = useState(PAINT_SWATCHES[1]);
  const [paintedUrl, setPaintedUrl] = useState<string | null>(null);
  const isPlacing = placingKey !== null;

  useEffect(() => {
    let cancelled = false;
    loadManifest()
      .then(async (m) => {
        if (cancelled) return;
        setManifest(m);
        // A stored look may name parts this pack version no longer has; fall back to a random one.
        const stored = initialPeep?.look;
        const usable =
          stored &&
          find(m.poses[stored.stance] ?? [], stored.pose) &&
          find(m.heads, stored.head) &&
          find(m.faces, stored.face) &&
          (!stored.beard || find(m.facialHair, stored.beard)) &&
          (!stored.glasses || find(m.accessories, stored.glasses));
        setLook(usable ? stored : randomLook(m, "standing"));
        if (!usable) setFills([]);
        const files = [...m.poses.standing, ...m.poses.sitting, ...m.heads, ...m.faces, ...m.facialHair, ...m.accessories].map((p) => p.file);
        const loaded = await Promise.all(files.map((f) => loadText(f).then((t): [string, string] => [f, t])));
        if (!cancelled) setTexts(Object.fromEntries(loaded));
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Could not load the Peeps pack"));
    return () => {
      cancelled = true;
    };
    // Only the figure it opened on matters: later edits live in this component's own state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fills are click positions on the figure, so any change to the figure itself clears them.
  const update = (patch: Partial<Look>) => {
    setLook((previous) => (previous ? { ...previous, ...patch } : previous));
    setFills([]);
  };

  function setStance(stance: Stance) {
    if (!manifest || !look) return;
    // A pose belongs to one stance, so switching picks that stance's first pose.
    update({ stance, pose: manifest.poses[stance][0].id });
  }

  const figure = useMemo(() => (manifest && look ? composeFigure(manifest, texts, look) : null), [manifest, texts, look]);
  const plainUrl = figure ? svgDataUrl(figure.svg) : null;
  const previewUrl = fills.length > 0 && paintedUrl ? paintedUrl : plainUrl;

  useEffect(() => {
    if (!figure || fills.length === 0) return;
    let cancelled = false;
    paintFigure(figure.svg, figure.box, fills, PREVIEW_WIDTH)
      .then((canvas) => !cancelled && setPaintedUrl(canvas.toDataURL("image/png")))
      .catch(() => !cancelled && setPaintedUrl(null));
    return () => {
      cancelled = true;
    };
  }, [figure, fills]);

  function handlePreviewClick(event: React.MouseEvent<HTMLImageElement>) {
    if (!figure) return;
    // The image is letterboxed (object-contain) inside its box: map the click onto the figure's frame.
    const rect = event.currentTarget.getBoundingClientRect();
    const aspect = figure.box[2] / figure.box[3];
    const shownW = Math.min(rect.width, rect.height * aspect);
    const shownH = shownW / aspect;
    const x = (event.clientX - rect.left - (rect.width - shownW) / 2) / shownW;
    const y = (event.clientY - rect.top - (rect.height - shownH) / 2) / shownH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    // Saved with the figure (the backend caps that at 8000 characters), so keep the list bounded.
    setFills((previous) => [...previous.slice(-(MAX_FILLS - 1)), { x, y, color: paintColor }]);
  }

  const thumbnails = useMemo(() => {
    if (!manifest || !look || mode !== "poses") return [];
    const options: Part[] =
      activePart === "pose" ? manifest.poses[look.stance] : activePart === "head" ? manifest.heads : activePart === "face" ? manifest.faces : activePart === "beard" ? manifest.facialHair : manifest.accessories;
    const key = activePart === "pose" ? "pose" : activePart === "head" ? "head" : activePart === "face" ? "face" : activePart === "beard" ? "beard" : "glasses";
    return options.map((part) => {
      const swapped: Look = { ...look, [key]: part.id, flip: false };
      // Face-and-head parts are judged on a close-up of the head; poses on the whole figure.
      const composed = composeFigure(manifest, texts, swapped, activePart === "pose" ? "all" : "head");
      return { part, url: composed ? svgDataUrl(composed.svg) : null };
    });
  }, [manifest, texts, look, mode, activePart]);

  function handlePlaceFigure() {
    if (isPlacing || !figure || !look) return;
    setError(null);
    rasterizeCropped(figure.svg, figure.box[2], figure.box[3], fills)
      .then(({ file, aspect }) => onPlace(file, "peep-pack", aspect, { kind: "pack", look, fills }))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not add this figure"));
  }

  function handlePlaceReady(file: string) {
    if (isPlacing) return;
    setError(null);
    loadText(file)
      .then((text) => {
        const [, , w, h] = (text.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 1 1").split(/\s+/).map(Number);
        return rasterizeCropped(text.replace(/<svg ([^>]*?)\swidth="[^"]*"\s+height="[^"]*"/, "<svg $1"), w, h);
      })
      .then(({ file: png, aspect }) => onPlace(png, file, aspect))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not add this figure"));
  }

  if (!manifest || !look) {
    return <p className="text-xs text-muted">{error ?? "Loading the pack…"}</p>;
  }

  const selected: Record<PartKey, string | null> = { pose: look.pose, head: look.head, face: look.face, beard: look.beard, glasses: look.glasses };
  const optional = activePart === "beard" || activePart === "glasses";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {/* Ready-made figures carry no settings, so an edit reopens only the pose mixer. */}
        {(initialPeep ? [] : (["poses", "ready"] as Mode[])).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            aria-pressed={mode === id}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] ${mode === id ? "border-accent bg-accent text-accent-foreground" : "border-border text-muted hover:text-foreground"}`}
          >
            {id === "poses" ? "Mix a pose" : "Ready-made"}
          </button>
        ))}
        {error && <span className="text-[11px] text-red-600">{error}</span>}
      </div>

      {mode === "poses" ? (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex w-44 shrink-0 flex-col gap-2">
            <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded-md border border-border" style={CHECKERBOARD_STYLE}>
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data: URL generated in-browser
                <img src={previewUrl} alt="Your peep" onClick={handlePreviewClick} className="h-full w-full cursor-crosshair object-contain" />
              ) : (
                <span className="text-[11px] text-muted">Loading…</span>
              )}
            </div>
            <div className="flex gap-1">
              {(["standing", "sitting"] as Stance[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStance(s)}
                  aria-pressed={look.stance === s}
                  className={`flex-1 rounded-md border px-2 py-1 text-xs capitalize ${look.stance === s ? "border-accent" : "border-border"}`}
                >
                  {s}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => {
                setLook(randomLook(manifest, look.stance));
                setFills([]);
              }} className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent">
              🎲 Surprise me
            </button>
            <div className="flex flex-col gap-1 rounded-md border border-border p-1.5">
              <span className="text-[11px] text-muted">Paint: pick a colour, then click the figure</span>
              <div className="flex flex-wrap items-center gap-1">
                {PAINT_SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    onClick={() => setPaintColor(swatch)}
                    aria-label={`Paint ${swatch}`}
                    style={{ backgroundColor: swatch }}
                    className={`h-4 w-4 rounded-full border ${paintColor === swatch ? "ring-2 ring-accent ring-offset-1" : "border-border"}`}
                  />
                ))}
                <input
                  type="color"
                  value={paintColor}
                  onChange={(e) => setPaintColor(e.target.value)}
                  aria-label="Custom paint colour"
                  className="h-5 w-5 cursor-pointer rounded border border-border bg-transparent p-0"
                />
              </div>
              <div className="flex gap-1">
                <button type="button" onClick={() => setFills((previous) => previous.slice(0, -1))} disabled={fills.length === 0} className="flex-1 rounded border border-border px-1 py-0.5 text-[11px] hover:border-accent disabled:opacity-50">
                  Undo
                </button>
                <button type="button" onClick={() => setFills([])} disabled={fills.length === 0} className="flex-1 rounded border border-border px-1 py-0.5 text-[11px] hover:border-accent disabled:opacity-50">
                  Clear
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => update({ flip: !look.flip })}
              aria-pressed={look.flip}
              className={`rounded-md border px-2 py-1 text-xs ${look.flip ? "border-accent" : "border-border"}`}
            >
              Flip ↔
            </button>
            <button
              type="button"
              onClick={handlePlaceFigure}
              disabled={isPlacing || !figure}
              className="rounded-md bg-accent px-2 py-1.5 text-xs font-medium text-accent-foreground disabled:opacity-60"
            >
              {isPlacing ? "Working…" : submitLabel}
            </button>
            <p className="text-[10px] text-muted">Art: Open Peeps by Pablo Stanley. Change parts first: picking a different part clears your paint.</p>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap gap-1">
              {(Object.keys(PART_LABELS) as PartKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActivePart(key)}
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] ${activePart === key ? "border-accent bg-accent text-accent-foreground" : "border-border text-muted hover:text-foreground"}`}
                >
                  {PART_LABELS[key]}
                </button>
              ))}
            </div>
            <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto sm:grid-cols-5">
              {optional && (
                <button
                  type="button"
                  onClick={() => update({ [activePart === "beard" ? "beard" : "glasses"]: null })}
                  className={`flex aspect-square items-center justify-center rounded-md border text-[11px] text-muted ${selected[activePart] === null ? "border-accent ring-1 ring-accent" : "border-border hover:border-accent"}`}
                >
                  None
                </button>
              )}
              {thumbnails.map(({ part, url }) => (
                <button
                  key={part.id}
                  type="button"
                  onClick={() => update({ [activePart === "pose" ? "pose" : activePart]: part.id })}
                  title={part.label}
                  className={`aspect-square overflow-hidden rounded-md border ${selected[activePart] === part.id ? "border-accent ring-1 ring-accent" : "border-border hover:border-accent"}`}
                  style={CHECKERBOARD_STYLE}
                >
                  {url && (
                    // eslint-disable-next-line @next/next/no-img-element -- a data: URL generated in-browser
                    <img src={url} alt={part.label} className="h-full w-full object-contain" loading="lazy" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-1">
            {(Object.keys(READY_LABELS) as ReadyKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setReady(key)}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] ${ready === key ? "border-accent bg-accent text-accent-foreground" : "border-border text-muted hover:text-foreground"}`}
              >
                {READY_LABELS[key]}
              </button>
            ))}
          </div>
          <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto sm:grid-cols-5">
            {manifest.templates[ready].map((file) => (
              <button
                key={file}
                type="button"
                onClick={() => handlePlaceReady(file)}
                disabled={isPlacing}
                className="aspect-square overflow-hidden rounded-md border border-border hover:border-accent disabled:opacity-60"
                style={CHECKERBOARD_STYLE}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a static file from public/ */}
                <img src={BASE + file} alt="" className="h-full w-full object-contain" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
