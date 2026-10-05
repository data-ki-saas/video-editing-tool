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

// Body parts the artwork doesn't have; drawn by legsSvg / handSvg / footSvg below.
const HANDS = ["relaxed", "fist", "open"];
const LEGS = ["straight", "wide", "slim", "shorts", "skirt"];
const SHOES = ["sneakers", "boots", "barefoot"];

const SKIN_SWATCHES = colors.skin.values;
const CLOTHES_SWATCHES = [...colors.clothing.values, "#ffffff", "#2b2b2b", "#d64545"];
const INK_SWATCHES = ["#000000", "#2c1b18", "#4a312c", "#724133", "#1e2a5a", "#4b1d52", "#1f3d2b"];

type PartKey = "head" | "face" | "beard" | "glasses" | "mask" | "hands" | "legs" | "shoes";
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
  { key: "sitting", label: "Sitting", viewBox: "-60 0 820 2070", legs: true },
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
  hands: string;
  legs: string;
  shoes: string;
  ink: string;
  flip: boolean;
  pose: PoseKey;
}

interface PartTab {
  key: PartKey;
  label: string;
  variants: string[];
  optional: boolean;
  // Window of the canvas that frames just this part in its thumbnails.
  viewBox: string;
  // Body parts are shown on a whole-body figure; head parts use the bust framing.
  thumbPose?: PoseKey;
  // Which framings this tab applies to (default: all).
  poses?: PoseKey[];
}

const PART_TABS: PartTab[] = [
  { key: "head", label: "Hair & head", variants: HEADS, optional: false, viewBox: "150 60 520 520" },
  { key: "face", label: "Face", variants: FACES, optional: false, viewBox: "330 320 270 270" },
  { key: "beard", label: "Beard", variants: BEARDS, optional: true, viewBox: "200 300 420 420" },
  { key: "glasses", label: "Glasses", variants: GLASSES, optional: true, viewBox: "200 280 420 320" },
  { key: "mask", label: "Mask", variants: MASKS, optional: true, viewBox: "200 300 420 420" },
  { key: "hands", label: "Hands", variants: HANDS, optional: false, viewBox: "-70 1150 280 280", thumbPose: "half", poses: ["half", "sitting", "full"] },
  { key: "legs", label: "Legs", variants: LEGS, optional: false, viewBox: "-60 1180 900 780", thumbPose: "full", poses: ["sitting", "full"] },
  { key: "shoes", label: "Shoes", variants: SHOES, optional: false, viewBox: "-60 1700 900 400", thumbPose: "full", poses: ["full"] },
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
    hands: HANDS[0],
    legs: LEGS[0],
    shoes: SHOES[0],
    ink: INK_SWATCHES[0],
    flip: false,
    pose: "bust",
  };
}

// DiceBear's open-peeps art is a head-and-torso drawn to the waist (y ~1227) but
// clipped to a 704 square, which is the "bust" framing. The other poses drop the
// clip to reveal the waist-down torso; hands, and (for sitting / full body) legs
// and shoes, are drawn below it in the same loose, heavy-lined hand-drawn style
// (the art has no hands: its arms just end in open stubs at the hem).
const HEM_Y = 1227;
const LEG_CENTER_X = 385; // the torso's horizontal centre line
const LINE = 14; // matches the artwork's own ink weight
// Where the torso's two arm stubs end (viewer's left / right) and how wide they are.
const HAND_SPOTS = [
  { x: 40, width: 124 },
  { x: 688, width: 104 },
];

interface BodyLook {
  skin: string;
  pants: string;
  ink: string;
  hands: string;
  legs: string;
  shoes: string;
}

const inkStroke = (ink: string, width = LINE) =>
  `stroke="${ink}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"`;

/** One hand hanging off an arm stub: a skin fill (no outline across the wrist, so
 * it melts into the arm as the artwork's own open-ended arms do) plus ink lines. */
function handSvg(look: BodyLook, hx: number, width: number): string {
  const { skin, ink, hands } = look;
  const l = hx - width / 2;
  const r = hx + width / 2;
  const top = HEM_Y - 24;
  const fist = hands === "fist";
  const open = hands === "open";
  const bottom = top + (fist ? 128 : open ? 170 : 150);
  const body =
    `M${l} ${top} L${l + 6} ${bottom - 64} C${l + 4} ${bottom - 10} ${l + 30} ${bottom} ${hx} ${bottom} ` +
    `C${r - 30} ${bottom} ${r - 4} ${bottom - 10} ${r - 6} ${bottom - 64} L${r} ${top}`;
  const fill = `<path d="${body} Z" fill="${skin}"/>`;
  const outline = `<path d="${body}" fill="none" ${inkStroke(ink)}/>`;
  const fine = inkStroke(ink, 9);
  let detail: string;
  if (fist) {
    detail = `<path d="M${l + 14} ${bottom - 92} Q${hx} ${bottom - 80} ${r - 14} ${bottom - 92} M${l + 16} ${bottom - 62} Q${hx} ${bottom - 50} ${r - 16} ${bottom - 62} M${l + 24} ${bottom - 34} Q${hx} ${bottom - 24} ${r - 24} ${bottom - 34}" fill="none" ${fine}/>`;
  } else if (open) {
    const gap = (width - 24) / 4;
    detail = [1, 2, 3]
      .map((i) => `<path d="M${l + 12 + gap * i} ${bottom - 62} L${l + 12 + gap * i + (i - 2) * 4} ${bottom - 8}" fill="none" ${fine}/>`)
      .join("");
  } else {
    // Relaxed: fingers loosely curled, with the thumb tucked against the leg.
    detail =
      `<path d="M${hx - 16} ${bottom - 58} L${hx - 14} ${bottom - 10} M${hx + 12} ${bottom - 58} L${hx + 12} ${bottom - 10}" fill="none" ${fine}/>` +
      `<path d="M${r - 10} ${top + 36} Q${r - 40} ${top + 56} ${r - 34} ${top + 96}" fill="none" ${fine}/>`;
  }
  return fill + outline + detail;
}

function handsSvg(look: BodyLook): string {
  return HAND_SPOTS.map((spot) => handSvg(look, spot.x, spot.width)).join("");
}

interface Foot {
  // The ankle's inner / outer x and the y where the leg meets the shoe.
  inner: number;
  outer: number;
  y: number;
  side: -1 | 1;
}

function footSvg(look: BodyLook, foot: Foot): string {
  const { skin, ink, shoes } = look;
  const { y, side } = foot;
  const a = Math.min(foot.inner, foot.outer);
  const b = Math.max(foot.inner, foot.outer);
  // Feet splay slightly outward, so the toe end sticks out further on the outer side.
  const left = side === -1 ? a - 56 : a - 14;
  const right = side === -1 ? b + 14 : b + 56;
  const mid = (left + right) / 2;
  const stroke = inkStroke(ink);
  const fine = inkStroke(ink, 9);
  const boots = shoes === "boots";
  const topY = boots ? y - 130 : y - 14;
  const pad = shoes === "barefoot" ? -4 : boots ? 14 : 8;
  const fill = shoes === "barefoot" ? skin : boots ? "#7a5033" : "#ffffff";
  const bottom = y + 124;
  const shape =
    `<path d="M${a - pad} ${topY} L${b + pad} ${topY} L${b + pad + 2} ${y + 26} C${right + 4} ${y + 36} ${right + 8} ${y + 100} ${right - 26} ${bottom - 6} ` +
    `Q${mid} ${bottom + 8} ${left + 26} ${bottom - 6} C${left - 8} ${y + 100} ${left - 4} ${y + 36} ${a - pad - 2} ${y + 26} Z" fill="${fill}" ${stroke}/>`;
  if (shoes === "barefoot") {
    const toes = [0.2, 0.4, 0.6, 0.8].map((t) => `<path d="M${left + (right - left) * t} ${bottom - 30} l0 22" fill="none" ${fine}/>`).join("");
    return shape + toes;
  }
  const sole = `<path d="M${left + 4} ${bottom - 32} Q${mid} ${bottom - 18} ${right - 4} ${bottom - 32}" fill="none" ${fine}/>`;
  const trim = boots
    ? `<path d="M${a - pad + 4} ${topY + 34} Q${(a + b) / 2} ${topY + 52} ${b + pad - 4} ${topY + 34}" fill="none" ${fine}/>`
    : `<path d="M${a + 2} ${y + 36} Q${(a + b) / 2} ${y + 8} ${b - 2} ${y + 36}" fill="none" ${fine}/>`;
  return shape + sole + trim;
}

function legsSvg(pose: PoseKey, look: BodyLook): string {
  const cx = LEG_CENTER_X;
  const { pants, skin, ink } = look;
  const stroke = inkStroke(ink);
  const fine = inkStroke(ink, 9);
  const top = HEM_Y - 40; // tuck under the shirt hem
  const bare = look.legs === "shorts" || look.legs === "skirt";
  const flare = look.legs === "wide" ? 26 : look.legs === "slim" ? -26 : 0;
  const x = (side: -1 | 1, dx: number) => cx + side * dx;

  if (pose === "full") {
    const bottom = top + 650;
    const shortEnd = top + 270; // where shorts / a skirt stop and bare legs show
    const leg = (side: -1 | 1) => {
      const topIn = 8;
      const topOut = 222 + flare * 0.4;
      const botIn = 30 - flare * 0.4;
      const botOut = 202 + flare;
      const s = (dx: number) => x(side, dx);
      if (bare) {
        const barePath =
          `<path d="M${s(30)} ${shortEnd - 20} L${s(176)} ${shortEnd - 20} C${s(182)} ${top + 450} ${s(168)} ${top + 560} ${s(160)} ${bottom} ` +
          `L${s(48)} ${bottom} C${s(44)} ${top + 560} ${s(36)} ${top + 450} ${s(30)} ${shortEnd - 20} Z" fill="${skin}" ${stroke}/>`;
        const cloth =
          look.legs === "shorts"
            ? `<path d="M${s(topIn)} ${top} L${s(topOut)} ${top} C${s(topOut + 8)} ${top + 120} ${s(topOut + 14)} ${top + 200} ${s(topOut + 14)} ${shortEnd} ` +
              `Q${s(120)} ${shortEnd + 22} ${s(topIn + 4)} ${shortEnd - 6} C${s(topIn - 2)} ${top + 150} ${s(topIn)} ${top + 60} ${s(topIn)} ${top} Z" fill="${pants}" ${stroke}/>`
            : "";
        return barePath + cloth + footSvg(look, { inner: s(48), outer: s(160), y: bottom, side });
      }
      const path =
        `<path d="M${s(topIn)} ${top} L${s(topOut)} ${top} C${s(topOut + 10)} ${top + 220} ${s(botOut + 12)} ${top + 420} ${s(botOut)} ${bottom} ` +
        `L${s(botIn)} ${bottom} C${s(botIn - 6)} ${top + 420} ${s(topIn + 2)} ${top + 220} ${s(topIn)} ${top} Z" fill="${pants}" ${stroke}/>`;
      const wrinkles = `<path d="M${s(botOut - 30)} ${top + 300} q${-side * 34} 10 ${-side * 58} -2 M${s(botIn + 22)} ${bottom - 60} q${side * 40} 14 ${side * 90} 2" fill="none" ${fine}/>`;
      return path + wrinkles + footSvg(look, { inner: s(botIn), outer: s(botOut), y: bottom, side });
    };
    const skirt =
      look.legs === "skirt"
        ? `<path d="M${cx - 236} ${top} L${cx + 236} ${top} C${cx + 270} ${top + 150} ${cx + 300} ${top + 240} ${cx + 312} ${shortEnd} ` +
          `Q${cx} ${shortEnd + 44} ${cx - 312} ${shortEnd} C${cx - 300} ${top + 240} ${cx - 270} ${top + 150} ${cx - 236} ${top} Z" fill="${pants}" ${stroke}/>` +
          `<path d="M${cx - 110} ${top + 40} L${cx - 130} ${shortEnd + 6} M${cx} ${top + 40} L${cx} ${shortEnd + 14} M${cx + 110} ${top + 40} L${cx + 130} ${shortEnd + 6}" fill="none" ${fine}/>`
        : "";
    return leg(-1) + leg(1) + skirt;
  }

  // Sitting, front view: foreshortened thighs toward the viewer, shins dropping from the knees, on a stool.
  const seatY = top + 150;
  const kneeY = top + 250;
  const floorY = kneeY + 430;
  const stool =
    `<path d="M${cx - 322} ${seatY} L${cx + 322} ${seatY} L${cx + 326} ${seatY + 46} L${cx - 326} ${seatY + 46} Z" fill="#c8a27a" ${stroke}/>` +
    `<path d="M${cx - 284} ${seatY + 46} L${cx - 304} ${floorY + 120} M${cx + 284} ${seatY + 46} L${cx + 304} ${floorY + 120}" fill="none" ${inkStroke(ink, 22)}/>`;
  const thighs =
    `<path d="M${cx - 246} ${top} L${cx + 246} ${top} C${cx + 270} ${top + 90} ${cx + 270} ${kneeY - 40} ${cx + 262} ${kneeY} ` +
    `Q${cx + 258} ${kneeY + 56} ${cx + 206} ${kneeY + 52} L${cx - 206} ${kneeY + 52} Q${cx - 258} ${kneeY + 56} ${cx - 262} ${kneeY} ` +
    `C${cx - 270} ${kneeY - 40} ${cx - 270} ${top + 90} ${cx - 246} ${top} Z" fill="${pants}" ${stroke}/>` +
    `<path d="M${cx} ${top + 30} L${cx} ${kneeY + 40}" fill="none" ${fine}/>`;
  const shin = (side: -1 | 1) => {
    const s = (dx: number) => x(side, dx);
    const inner = 44 - flare * 0.4;
    const outer = 214 + flare;
    const lower = bare ? skin : pants;
    return (
      `<path d="M${s(inner)} ${kneeY + 40} L${s(outer)} ${kneeY + 40} C${s(outer - 4)} ${kneeY + 200} ${s(outer - 16)} ${kneeY + 330} ${s(outer - 20)} ${floorY} ` +
      `L${s(inner + 16)} ${floorY} C${s(inner + 12)} ${kneeY + 330} ${s(inner + 4)} ${kneeY + 200} ${s(inner)} ${kneeY + 40} Z" fill="${lower}" ${stroke}/>` +
      footSvg(look, { inner: s(inner + 16), outer: s(outer - 20), y: floorY, side })
    );
  };
  return stool + shin(-1) + shin(1) + thighs;
}

/** The peep as an SVG document. `viewBox` crops thumbnails to one part (always the bust framing). */
function peepSvg(peep: Peep, size: number, viewBox?: string, thumbPose?: PoseKey): string {
  const pose = POSES.find((p) => p.key === (thumbPose ?? (viewBox ? "bust" : peep.pose))) ?? POSES[0];
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
  if (pose.key === "bust") return viewBox ? svg.replace('viewBox="0 0 704 704"', `viewBox="${viewBox}"`) : svg;
  const frame = viewBox ?? pose.viewBox;
  const [, , vbWidth, vbHeight] = frame.split(" ").map(Number);
  let out = svg
    .replace('viewBox="0 0 704 704"', `viewBox="${frame}"`)
    .replace(/ width="[^"]*" height="[^"]*"/, ` width="${Math.round((size * vbWidth) / vbHeight)}" height="${size}"`)
    .replace(/ clip-path="url\(#clip-[^)]*\)"/, "");
  const look: BodyLook = { skin: peep.skin, pants: peep.pants, ink: peep.ink, hands: peep.hands, legs: peep.legs, shoes: peep.shoes };
  // Hands go on top of the torso (its arm stubs have no hands), just before the head
  // parts; inside DiceBear's own flip group, so they mirror with the figure.
  out = out.replace("<use ", `${handsSvg(look)}<use `);
  if (pose.legs) {
    const legs = legsSvg(pose.key, look);
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

  // Body-part tabs only appear for framings that show that part.
  const visibleTabs = PART_TABS.filter((tab) => !tab.poses || tab.poses.includes(peep.pose));
  const part = PART_TABS.find((tab) => tab.key === activePart && (!tab.poses || tab.poses.includes(peep.pose))) ?? PART_TABS[0];
  const selectedVariant = peep[part.key];
  const isPlacing = placingKey !== null;

  const previewUrl = useMemo(() => svgDataUrl(peepSvg(peep, 320)), [peep]);

  // Thumbnails show the whole current peep with only this part swapped, so a
  // choice is judged in context. Regenerated when the colours change.
  const thumbnails = useMemo(
    () =>
      part.variants.map((variant) => ({
        variant,
        url: svgDataUrl(peepSvg({ ...peep, [part.key]: variant }, 96, part.viewBox, part.thumbPose)),
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
          {visibleTabs.map((tab) => (
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
