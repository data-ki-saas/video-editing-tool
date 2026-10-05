"use client";

/**
 * "Peeps" tab of PropsDialog -- build a hand-drawn character from Open Peeps
 * (Pablo Stanley, CC0 -- https://www.openpeeps.com/) and drop it into the
 * scene like any other prop.
 *
 * The artwork comes from DiceBear's open-peeps style definition
 * (@dicebear/styles, CC0), rendered fully offline by @dicebear/core. Every
 * choice here is a direct DiceBear option: hair/head, face, beard, glasses and
 * mask are part pickers (with live thumbnails, not names), and skin / clothes /
 * hair-and-lines are colour swatches. It opens on a random character and has a
 * Randomize dice, so a casual creator never starts from a blank slate.
 *
 * Note "Lines & hair" drives DiceBear's `ink` colour, which is the outline of
 * every part as well as most hair, so it is limited to dark swatches (a white
 * outline would erase the face). Placed like a prop: rasterized to a
 * transparent PNG, tightly cropped, then uploaded as an image overlay.
 */
import { useMemo, useState } from "react";
import { Avatar, Style } from "@dicebear/core";
import openPeeps from "@dicebear/styles/open-peeps.json";

const RASTER_SIZE = 1408; // 2x the style's 704 canvas, so scaled-up peeps stay crisp
const RASTER_MAX_SIDE = 2400; // cap for the long side of tall poses (full body / sitting)
const ALPHA_VISIBLE_THRESHOLD = 16;

const style = new Style(openPeeps);
const components = openPeeps.components as unknown as Record<string, { variants: Record<string, unknown> }>;
const colors = openPeeps.colors as unknown as Record<string, { values: string[] }>;

const HEADS = Object.keys(components.head.variants);
const FACES = Object.keys(components.expression.variants);
const BEARDS = Object.keys(components.facialHair.variants);
const GLASSES = Object.keys(components.accessories.variants);
const MASKS = Object.keys(components.mask.variants);

const SKIN_SWATCHES = colors.skin.values;
const CLOTHES_SWATCHES = [...colors.clothing.values, "#ffffff", "#2b2b2b", "#d64545"];
const INK_SWATCHES = ["#000000", "#2c1b18", "#4a312c", "#724133", "#1e2a5a", "#4b1d52", "#1f3d2b"];

type PartKey = "head" | "face" | "beard" | "glasses" | "mask";
type PoseKey = "bust" | "half" | "sitting" | "full";

interface Pose {
  key: PoseKey;
  label: string;
  // Canvas window (in the style's 704 coordinates) framing the pose.
  viewBox: string;
  legs: boolean;
}

const POSES: Pose[] = [
  { key: "bust", label: "Bust", viewBox: "0 0 704 704", legs: false },
  { key: "half", label: "Half body", viewBox: "-60 0 820 1250", legs: false },
  { key: "sitting", label: "Sitting", viewBox: "-60 0 820 1980", legs: true },
  { key: "full", label: "Full body", viewBox: "-60 0 820 2150", legs: true },
];

const PANTS_SWATCHES = ["#3b4a6b", "#2b2b2b", "#6b7a8f", "#8a6a4a", "#556b2f", "#a33b3b", "#d9d2c0"];

interface Peep {
  head: string;
  face: string;
  beard: string | null;
  glasses: string | null;
  mask: string | null;
  skin: string;
  clothes: string;
  pants: string;
  ink: string;
  flip: boolean;
  pose: PoseKey;
}

interface PartTab {
  key: PartKey;
  label: string;
  variants: string[];
  optional: boolean;
  // Square window of the 704 canvas that frames just this part in its thumbnails.
  viewBox: string;
}

const PART_TABS: PartTab[] = [
  { key: "head", label: "Hair & head", variants: HEADS, optional: false, viewBox: "150 60 520 520" },
  { key: "face", label: "Face", variants: FACES, optional: false, viewBox: "330 320 270 270" },
  { key: "beard", label: "Beard", variants: BEARDS, optional: true, viewBox: "200 300 420 420" },
  { key: "glasses", label: "Glasses", variants: GLASSES, optional: true, viewBox: "200 280 420 320" },
  { key: "mask", label: "Mask", variants: MASKS, optional: true, viewBox: "200 300 420 420" },
];

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

function randomPeep(): Peep {
  return {
    head: pick(HEADS),
    face: pick(FACES),
    beard: Math.random() < 0.25 ? pick(BEARDS) : null,
    glasses: Math.random() < 0.25 ? pick(GLASSES) : null,
    mask: null,
    skin: pick(SKIN_SWATCHES),
    clothes: pick(CLOTHES_SWATCHES),
    pants: pick(PANTS_SWATCHES),
    ink: INK_SWATCHES[0],
    flip: false,
    pose: "bust",
  };
}

// DiceBear's open-peeps art is a head-and-torso drawn to the waist (y ~1227) but
// clipped to a 704 square, which is the "bust" framing. The other poses drop the
// clip to reveal the waist-down torso; sitting / full body also draw legs below it.
const HEM_Y = 1227;
const LEG_CENTER_X = 385; // the torso's horizontal centre line
const SHOE_FILL = "#ffffff";

function legsSvg(pose: PoseKey, pants: string, ink: string): string {
  const cx = LEG_CENTER_X;
  const strokeOf = (width: number) => `stroke="${ink}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"`;
  const stroke = strokeOf(12);
  const top = HEM_Y - 40; // tuck under the shirt hem
  if (pose === "full") {
    const leg = (side: -1 | 1) => {
      const inner = cx + side * 12;
      const outer = cx + side * 240;
      const hemInner = cx + side * 30;
      const hemOuter = cx + side * 220;
      const bottom = top + 780;
      const shoeOuter = cx + side * 250;
      const shoeToe = cx + side * 8;
      return (
        `<path d="M${inner} ${top} L${outer} ${top} L${hemOuter} ${bottom} L${hemInner} ${bottom} Z" fill="${pants}" ${stroke}/>` +
        `<path d="M${hemInner - side * 6} ${bottom - 6} L${hemOuter + side * 6} ${bottom - 6} L${shoeOuter} ${bottom + 50} Q${shoeOuter + side * 6} ${bottom + 90} ${shoeOuter - side * 40} ${bottom + 90} L${shoeToe} ${bottom + 90} Q${shoeToe - side * 6} ${bottom + 20} ${hemInner - side * 6} ${bottom - 6} Z" fill="${SHOE_FILL}" ${stroke}/>`
      );
    };
    return leg(-1) + leg(1);
  }
  // Sitting, front view: foreshortened thighs toward the viewer, shins dropping from the knees, on a stool.
  const seatY = top + 150;
  const kneeY = top + 250;
  const floorY = kneeY + 420;
  const stool =
    `<rect x="${cx - 320}" y="${seatY}" width="640" height="46" rx="14" fill="#c8a27a" ${stroke}/>` +
    `<path d="M${cx - 280} ${seatY + 46} L${cx - 300} ${floorY + 90} M${cx + 280} ${seatY + 46} L${cx + 300} ${floorY + 90}" fill="none" ${strokeOf(20)}/>`;
  const thighs = `<path d="M${cx - 250} ${top} L${cx + 250} ${top} L${cx + 262} ${kneeY} Q${cx + 262} ${kneeY + 50} ${cx + 215} ${kneeY + 50} L${cx - 215} ${kneeY + 50} Q${cx - 262} ${kneeY + 50} ${cx - 262} ${kneeY} Z" fill="${pants}" ${stroke}/>`;
  const shin = (side: -1 | 1) => {
    const a = cx + side * 40;
    const b = cx + side * 230;
    return (
      `<path d="M${a} ${kneeY + 40} L${b} ${kneeY + 40} L${b - side * 14} ${floorY} L${a + side * 14} ${floorY} Z" fill="${pants}" ${stroke}/>` +
      `<path d="M${a + side * 6} ${floorY - 6} L${b - side * 20} ${floorY - 6} L${b + side * 14} ${floorY + 36} Q${b + side * 18} ${floorY + 76} ${b - side * 24} ${floorY + 76} L${a - side * 10} ${floorY + 76} Q${a - side * 16} ${floorY + 10} ${a + side * 6} ${floorY - 6} Z" fill="${SHOE_FILL}" ${stroke}/>`
    );
  };
  return stool + shin(-1) + shin(1) + thighs;
}

/** The peep as an SVG document. `viewBox` crops thumbnails to one part (always the bust framing). */
function peepSvg(peep: Peep, size: number, viewBox?: string): string {
  const pose = viewBox ? POSES[0] : (POSES.find((p) => p.key === peep.pose) ?? POSES[0]);
  const svg = new Avatar(style, {
    seed: "peep", // every choice below is explicit, so the seed decides nothing visible
    size,
    flip: peep.flip ? "horizontal" : "none",
    headVariant: peep.head,
    expressionVariant: peep.face,
    facialHairVariant: peep.beard ?? BEARDS[0],
    facialHairProbability: peep.beard ? 100 : 0,
    accessoriesVariant: peep.glasses ?? GLASSES[0],
    accessoriesProbability: peep.glasses ? 100 : 0,
    maskVariant: peep.mask ?? MASKS[0],
    maskProbability: peep.mask ? 100 : 0,
    skinColor: peep.skin,
    clothingColor: peep.clothes,
    inkColor: peep.ink,
    headContrastColor: peep.ink, // the few hair styles drawn in this colour match the lines
  } as ConstructorParameters<typeof Avatar>[1]).toString();
  if (viewBox) return svg.replace('viewBox="0 0 704 704"', `viewBox="${viewBox}"`);
  if (pose.key === "bust") return svg;
  const [, , vbWidth, vbHeight] = pose.viewBox.split(" ").map(Number);
  let out = svg
    .replace('viewBox="0 0 704 704"', `viewBox="${pose.viewBox}"`)
    .replace(/ width="[^"]*" height="[^"]*"/, ` width="${Math.round((size * vbWidth) / vbHeight)}" height="${size}"`)
    .replace(/ clip-path="url\(#clip-[^)]*\)"/, "");
  if (pose.legs) {
    const legs = legsSvg(pose.key, peep.pants, peep.ink);
    const mirrored = peep.flip ? `<g transform="translate(704, 0) scale(-1, 1)">${legs}</g>` : legs;
    out = out.replace("</defs>", `</defs>${mirrored}`);
  }
  return out;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Transparent PNG of the peep, cropped to its visible pixels, plus that crop's aspect ratio. */
async function rasterizePeep(peep: Peep): Promise<{ file: File; aspect: number }> {
  const img = new Image();
  const pose = POSES.find((p) => p.key === peep.pose) ?? POSES[0];
  const [, , vbWidth, vbHeight] = pose.viewBox.split(" ").map(Number);
  // Tall poses are rasterized smaller than 2x so the canvas stays a sane size.
  const scale = Math.min(RASTER_SIZE / 704, RASTER_MAX_SIDE / Math.max(vbWidth, vbHeight));
  const rasterW = Math.round(vbWidth * scale);
  const rasterH = Math.round(vbHeight * scale);
  img.src = svgDataUrl(peepSvg(peep, rasterH));
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = rasterW;
  canvas.height = rasterH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not draw this peep");
  ctx.drawImage(img, 0, 0, rasterW, rasterH);
  const { data } = ctx.getImageData(0, 0, rasterW, rasterH);
  let minX = rasterW, minY = rasterH, maxX = -1, maxY = -1;
  for (let y = 0; y < rasterH; y++) {
    for (let x = 0; x < rasterW; x++) {
      if (data[(y * rasterW + x) * 4 + 3] > ALPHA_VISIBLE_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("Could not draw this peep");
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cropped = document.createElement("canvas");
  cropped.width = width;
  cropped.height = height;
  cropped.getContext("2d")?.drawImage(canvas, minX, minY, width, height, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => cropped.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not draw this peep");
  return { file: new File([blob], "peep.png", { type: "image/png" }), aspect: width / height };
}

const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundColor: "#e5e5e5",
  backgroundImage:
    "linear-gradient(45deg, #cfcfcf 25%, transparent 25%, transparent 75%, #cfcfcf 75%), linear-gradient(45deg, #cfcfcf 25%, transparent 25%, transparent 75%, #cfcfcf 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
};

function SwatchRow({ label, value, swatches, onChange }: { label: string; value: string; swatches: string[]; onChange: (color: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-20 shrink-0 text-[11px] text-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-1">
        {swatches.map((swatch) => (
          <button
            key={swatch}
            type="button"
            onClick={() => onChange(swatch)}
            aria-label={`${label} ${swatch}`}
            style={{ backgroundColor: swatch }}
            className={`h-5 w-5 rounded-full border ${value.toLowerCase() === swatch.toLowerCase() ? "ring-2 ring-accent ring-offset-1" : "border-border"}`}
          />
        ))}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Custom ${label.toLowerCase()} colour`}
          className="h-6 w-6 cursor-pointer rounded border border-border bg-transparent p-0"
        />
      </div>
    </div>
  );
}

export function PeepsTab({
  placingKey,
  onPlace,
}: {
  placingKey: string | null;
  // `aspect` is the cropped artwork's width/height, so it is placed unsquashed.
  onPlace: (file: File, key: string, aspect: number) => void;
}) {
  const [peep, setPeep] = useState<Peep>(randomPeep);
  const [activePart, setActivePart] = useState<PartKey>("head");
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<Peep>) => setPeep((previous) => ({ ...previous, ...patch }));

  const part = PART_TABS.find((tab) => tab.key === activePart) ?? PART_TABS[0];
  const selectedVariant = peep[part.key];
  const isPlacing = placingKey !== null;

  const previewUrl = useMemo(() => svgDataUrl(peepSvg(peep, 320)), [peep]);

  // Thumbnails show the whole current peep with only this part swapped, so a
  // choice is judged in context. Regenerated when the colours change.
  const thumbnails = useMemo(
    () =>
      part.variants.map((variant) => ({
        variant,
        url: svgDataUrl(peepSvg({ ...peep, [part.key]: variant }, 96, part.viewBox)),
      })),
    // Only this part's own variant is overridden, so the rest of `peep` is the dependency.
    [peep, part],
  );

  function handlePlace() {
    if (isPlacing) return;
    setError(null);
    rasterizePeep(peep)
      .then(({ file, aspect }) => onPlace(file, "peep", aspect))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not add this peep"));
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <div className="flex w-44 shrink-0 flex-col gap-2">
        <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border border-border" style={CHECKERBOARD_STYLE}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL generated in-browser */}
          <img src={previewUrl} alt="Your peep" className="h-full w-full object-contain" />
        </div>
        <button
          type="button"
          onClick={() => setPeep((previous) => ({ ...randomPeep(), skin: previous.skin, ink: previous.ink, flip: previous.flip, pose: previous.pose }))}
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
        >
          🎲 Surprise me
        </button>
        <button
          type="button"
          onClick={() => update({ flip: !peep.flip })}
          aria-pressed={peep.flip}
          className={`rounded-md border px-2 py-1 text-xs ${peep.flip ? "border-accent" : "border-border"}`}
        >
          Flip ↔
        </button>
        <button
          type="button"
          onClick={handlePlace}
          disabled={isPlacing}
          className="rounded-md bg-accent px-2 py-1.5 text-xs font-medium text-accent-foreground disabled:opacity-60"
        >
          {isPlacing ? "Adding…" : "Add to reel"}
        </button>
        {error && <p className="text-[11px] text-red-600">{error}</p>}
        <p className="text-[10px] text-muted">
          Placed like a prop: drag, resize and trim it on the time bar. Colours and parts are fixed once placed -- delete and
          re-add to change them. Art: Open Peeps by Pablo Stanley (CC0).
        </p>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
          <SwatchRow label="Skin" value={peep.skin} swatches={SKIN_SWATCHES} onChange={(skin) => update({ skin })} />
          <SwatchRow label="Clothes" value={peep.clothes} swatches={CLOTHES_SWATCHES} onChange={(clothes) => update({ clothes })} />
          {POSES.find((p) => p.key === peep.pose)?.legs && (
            <SwatchRow label="Pants" value={peep.pants} swatches={PANTS_SWATCHES} onChange={(pants) => update({ pants })} />
          )}
          <SwatchRow label="Lines & hair" value={peep.ink} swatches={INK_SWATCHES} onChange={(ink) => update({ ink })} />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="w-20 shrink-0 text-[11px] text-muted">Framing</span>
          {POSES.map((pose) => (
            <button
              key={pose.key}
              type="button"
              onClick={() => update({ pose: pose.key })}
              aria-pressed={peep.pose === pose.key}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] ${peep.pose === pose.key ? "border-accent bg-accent text-accent-foreground" : "border-border text-muted hover:text-foreground"}`}
            >
              {pose.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          {PART_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActivePart(tab.key)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] ${activePart === tab.key ? "border-accent bg-accent text-accent-foreground" : "border-border text-muted hover:text-foreground"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto sm:grid-cols-5">
          {part.optional && (
            <button
              type="button"
              onClick={() => update({ [part.key]: null })}
              className={`flex aspect-square items-center justify-center rounded-md border text-[11px] text-muted ${selectedVariant === null ? "border-accent ring-1 ring-accent" : "border-border hover:border-accent"}`}
            >
              None
            </button>
          )}
          {thumbnails.map(({ variant, url }) => (
            <button
              key={variant}
              type="button"
              onClick={() => update({ [part.key]: variant })}
              title={variant.replace(/([a-z])([A-Z0-9])/g, "$1 $2")}
              className={`aspect-square overflow-hidden rounded-md border ${selectedVariant === variant ? "border-accent ring-1 ring-accent" : "border-border hover:border-accent"}`}
              style={CHECKERBOARD_STYLE}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL generated in-browser */}
              <img src={url} alt={variant} className="h-full w-full object-contain" loading="lazy" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
