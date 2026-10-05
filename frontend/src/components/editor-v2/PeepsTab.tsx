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

interface Peep {
  head: string;
  face: string;
  beard: string | null;
  glasses: string | null;
  mask: string | null;
  skin: string;
  clothes: string;
  ink: string;
  flip: boolean;
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
    ink: INK_SWATCHES[0],
    flip: false,
  };
}

/** The peep as an SVG document. `viewBox` crops thumbnails to one part. */
function peepSvg(peep: Peep, size: number, viewBox?: string): string {
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
  return viewBox ? svg.replace('viewBox="0 0 704 704"', `viewBox="${viewBox}"`) : svg;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Transparent PNG of the peep, cropped to its visible pixels, plus that crop's aspect ratio. */
async function rasterizePeep(peep: Peep): Promise<{ file: File; aspect: number }> {
  const img = new Image();
  img.src = svgDataUrl(peepSvg(peep, RASTER_SIZE));
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = RASTER_SIZE;
  canvas.height = RASTER_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not draw this peep");
  ctx.drawImage(img, 0, 0, RASTER_SIZE, RASTER_SIZE);
  const { data } = ctx.getImageData(0, 0, RASTER_SIZE, RASTER_SIZE);
  let minX = RASTER_SIZE, minY = RASTER_SIZE, maxX = -1, maxY = -1;
  for (let y = 0; y < RASTER_SIZE; y++) {
    for (let x = 0; x < RASTER_SIZE; x++) {
      if (data[(y * RASTER_SIZE + x) * 4 + 3] > ALPHA_VISIBLE_THRESHOLD) {
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
          onClick={() => setPeep((previous) => ({ ...randomPeep(), skin: previous.skin, ink: previous.ink, flip: previous.flip }))}
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
          <SwatchRow label="Lines & hair" value={peep.ink} swatches={INK_SWATCHES} onChange={(ink) => update({ ink })} />
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
