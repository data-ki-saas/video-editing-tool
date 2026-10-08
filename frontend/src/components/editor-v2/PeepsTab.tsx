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
import { useEffect, useMemo, useState } from "react";
import { Avatar, Style } from "@dicebear/core";
import openPeeps from "@dicebear/styles/open-peeps.json";
import { PEEP_ASSET_FILENAME } from "@/lib/api";

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
const GESTURES = ["none", "wave", "thumbsUp", "peace", "point", "hips", "crossed", "cheer"];
const HANDS = ["relaxed", "fist", "open"];
const LEGS = ["straight", "wide", "slim", "shorts", "skirt"];
const SHOES = ["sneakers", "boots", "barefoot"];

const SKIN_SWATCHES = colors.skin.values;
const CLOTHES_SWATCHES = [...colors.clothing.values, "#ffffff", "#2b2b2b", "#d64545"];
const INK_SWATCHES = ["#000000", "#2c1b18", "#4a312c", "#724133", "#1e2a5a", "#4b1d52", "#1f3d2b"];

type PartKey = "head" | "face" | "beard" | "glasses" | "mask" | "gesture" | "hands" | "legs" | "shoes";
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
  { key: "half", label: "Half body", viewBox: "-340 0 1408 1250", legs: false },
  { key: "sitting", label: "Sitting", viewBox: "-340 0 1408 2070", legs: true },
  { key: "full", label: "Full body", viewBox: "-340 0 1408 2150", legs: true },
];

const PANTS_SWATCHES = ["#3b4a6b", "#2b2b2b", "#6b7a8f", "#8a6a4a", "#556b2f", "#a33b3b", "#d9d2c0"];

export interface Peep {
  head: string;
  face: string;
  beard: string | null;
  glasses: string | null;
  mask: string | null;
  skin: string;
  clothes: string;
  pants: string;
  hands: string;
  gesture: string;
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
  { key: "gesture", label: "Gesture", variants: GESTURES, optional: false, viewBox: "-340 380 1408 900", thumbPose: "half", poses: ["half", "sitting", "full"] },
  { key: "hands", label: "Hands", variants: HANDS, optional: false, viewBox: "-70 1150 280 280", thumbPose: "half", poses: ["half", "sitting", "full"] },
  { key: "legs", label: "Legs", variants: LEGS, optional: false, viewBox: "-60 1180 900 780", thumbPose: "full", poses: ["sitting", "full"] },
  { key: "shoes", label: "Shoes", variants: SHOES, optional: false, viewBox: "-60 1700 900 400", thumbPose: "full", poses: ["full"] },
];

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

// Named characters, kept in this browser only, so a peep can be reopened later
// (e.g. to swap just its face and place it again to animate speech).
const SAVED_PEEPS_KEY = "peeps.saved";

interface SavedPeep {
  name: string;
  peep: Peep;
}

function readSavedPeeps(): SavedPeep[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_PEEPS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedPeeps(list: SavedPeep[]) {
  try {
    localStorage.setItem(SAVED_PEEPS_KEY, JSON.stringify(list));
  } catch {
    // Storage blocked or full: saving is a convenience, the peep itself still works.
  }
}

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
    gesture: GESTURES[0],
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
  gesture: string;
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

/** The hanging hands, except on sides where a gesture arm replaces them. */
function handsSvg(look: BodyLook, skipSides: ("L" | "R")[]): string {
  return HAND_SPOTS.map((spot, i) => (skipSides.includes(i === 0 ? "L" : "R") ? "" : handSvg(look, spot.x, spot.width))).join("");
}

// --- Arm gestures -----------------------------------------------------------
// The artwork's arms only ever hang at the sides. For a gesture, the original
// forearm on that side is masked away (below the sleeve hem) and a new arm +
// hand is drawn, built from fat round-capped strokes: every limb is first drawn
// wide in ink, then narrower in skin on top, which gives the same heavy
// outlined, merged look as the artwork. Everything is authored for the
// viewer's-left arm and mirrored (about the stubs' axis, x = 364) for the right.
const ARM_MIRROR_X = 728;
const SLEEVE_HEM_Y = 962; // just under the sleeve's hem line; front-layer forearms start here (the mask follows the slanted hem itself)
const ARM_WIDTH = 92;

type Pt = [number, number];
interface Limb {
  pts: Pt[];
  w: number;
  cap?: "round" | "butt";
}

interface GestureDef {
  sides: ("L" | "R")[];
  // Raised arms tuck behind the sleeve; arms across the body must sit in front of the shirt.
  layer: "behind" | "front";
}

const GESTURE_DEFS: Record<string, GestureDef> = {
  wave: { sides: ["L"], layer: "behind" },
  thumbsUp: { sides: ["L"], layer: "behind" },
  peace: { sides: ["L"], layer: "behind" },
  point: { sides: ["L"], layer: "behind" },
  cheer: { sides: ["L", "R"], layer: "behind" },
  hips: { sides: ["L", "R"], layer: "front" },
  crossed: { sides: ["L", "R"], layer: "front" },
};

const pathOf = (pts: Pt[]) => pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");

/** Limbs as one merged shape: all the ink first, then all the skin over it. */
function limbsSvg(limbs: Limb[], skin: string, ink: string): string {
  const stroke = (l: Limb, color: string, width: number) => {
    const pts = l.pts.length === 1 ? [l.pts[0], [l.pts[0][0] + 0.01, l.pts[0][1]] as Pt] : l.pts;
    return `<path d="${pathOf(pts)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="${l.cap ?? "round"}"/>`;
  };
  return limbs.map((l) => stroke(l, ink, l.w + 2 * LINE)).join("") + limbs.map((l) => stroke(l, skin, l.w)).join("");
}

const linesSvg = (lines: Pt[][], ink: string) =>
  lines.map((pts) => `<path d="${pathOf(pts)}" fill="none" ${inkStroke(ink, 9)}/>`).join("");

interface HandShape {
  limbs: Limb[];
  lines: Pt[][];
}

/** A hand in its own coordinates: wrist at the origin, fingers pointing up (-y). */
function raisedHand(kind: string): HandShape {
  switch (kind) {
    case "thumbsUp":
      return {
        limbs: [
          { pts: [[0, -22], [0, -72]], w: 116 },
          { pts: [[-34, -72], [-34, -152]], w: 34 },
        ],
        lines: [[[-6, -30], [48, -30]], [[-6, -48], [48, -48]], [[-6, -66], [48, -66]]],
      };
    case "peace":
      return {
        limbs: [
          { pts: [[0, -22], [0, -62]], w: 104 },
          { pts: [[-18, -62], [-38, -168]], w: 26 },
          { pts: [[18, -62], [38, -168]], w: 26 },
          { pts: [[-46, -34], [-22, -54]], w: 24 },
        ],
        lines: [[[-4, -36], [44, -36]], [[-4, -52], [44, -52]]],
      };
    case "point":
      return {
        limbs: [
          { pts: [[0, -22], [0, -62]], w: 104 },
          { pts: [[-18, -62], [-18, -182]], w: 28 },
          { pts: [[-50, -42], [-30, -64]], w: 24 },
        ],
        lines: [[[2, -34], [46, -34]], [[2, -52], [46, -52]]],
      };
    default: // open palm (wave / cheer)
      return {
        limbs: [
          { pts: [[0, -22], [0, -70]], w: 130 },
          ...[-45, -15, 15, 45].map((fx): Limb => ({ pts: [[fx, -76], [fx * 1.14, -168]], w: 24 })),
          { pts: [[-58, -40], [-94, -104]], w: 26 },
        ],
        lines: [],
      };
  }
}

/** Puts a hand's local shape at `wrist`, tilted to continue the forearm's direction. */
function placeHand(shape: HandShape, wrist: Pt, angleDeg: number): HandShape {
  const rad = (angleDeg * Math.PI) / 180;
  const map = ([px, py]: Pt): Pt => [wrist[0] + px * Math.cos(rad) - py * Math.sin(rad), wrist[1] + px * Math.sin(rad) + py * Math.cos(rad)];
  return { limbs: shape.limbs.map((l) => ({ ...l, pts: l.pts.map(map) })), lines: shape.lines.map((l) => l.map(map)) };
}

/** The gesture arm for the viewer's-left side, as a skin-and-ink SVG fragment. */
function leftArmSvg(gesture: string, look: BodyLook): string {
  const { skin, ink } = look;
  if (gesture === "hips" || gesture === "crossed") {
    const limbs: Limb[] =
      gesture === "hips"
        ? [
            { pts: [[62, SLEEVE_HEM_Y], [62, 1004], [-30, 1064], [150, 1130]], w: 98, cap: "butt" },
            { pts: [[160, 1134]], w: 104 },
          ]
        : [
            { pts: [[62, SLEEVE_HEM_Y], [48, 1050], [470, 905]], w: 94, cap: "butt" },
            { pts: [[500, 898]], w: 104 },
          ];
    const lines: Pt[][] =
      gesture === "hips"
        ? [[[136, 1100], [190, 1112]], [[134, 1122], [190, 1134]], [[136, 1144], [186, 1154]]]
        : [[[486, 868], [530, 884]], [[484, 890], [530, 904]], [[488, 912], [528, 924]]];
    return limbsSvg(limbs, skin, ink) + linesSvg(lines, ink);
  }
  const elbow: Pt = [-10, 975];
  const wrist: Pt = gesture === "wave" ? [-118, 700] : gesture === "thumbsUp" ? [-84, 770] : gesture === "peace" ? [-100, 745] : gesture === "point" ? [-76, 735] : [-150, 720];
  const angle = (Math.atan2(wrist[0] - elbow[0], elbow[1] - wrist[1]) * 180) / Math.PI;
  const hand = placeHand(raisedHand(gesture === "cheer" || gesture === "wave" ? "open" : gesture), wrist, angle);
  const limbs: Limb[] = [{ pts: [[40, 900], elbow, wrist], w: ARM_WIDTH }, ...hand.limbs];
  return limbsSvg(limbs, skin, ink) + linesSvg(hand.lines, ink);
}

function gestureSvg(gesture: string, look: BodyLook): string {
  const def = GESTURE_DEFS[gesture];
  if (!def) return "";
  const left = leftArmSvg(gesture, look);
  return def.sides
    .map((side) => (side === "L" ? left : `<g transform="translate(${ARM_MIRROR_X} 0) scale(-1 1)">${left}</g>`))
    .join("");
}

/** SVG <mask> definition hiding the artwork's hanging forearm on the given sides. */
function armCutMaskDef(sides: ("L" | "R")[]): string {
  const cuts = sides.map((side) =>
    side === "L"
      ? `<polygon points="-400,944 -30,944 0,950 60,974 100,983 122,986 90,1320 -400,1320" fill="black"/>`
      : `<polygon points="1200,946 690,954 660,966 611,986 660,1320 1200,1320" fill="black"/>`,
  );
  return `<mask id="peep-armcut" maskUnits="userSpaceOnUse" x="-600" y="-200" width="2000" height="3000"><rect x="-600" y="-200" width="2000" height="3000" fill="white"/>${cuts.join("")}</mask>`;
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
  const look: BodyLook = {
    gesture: peep.gesture,
    skin: peep.skin,
    pants: peep.pants,
    ink: peep.ink,
    hands: peep.hands,
    legs: peep.legs,
    shoes: peep.shoes,
  };
  const gesture = GESTURE_DEFS[peep.gesture];
  let behind = "";
  let front = "";
  if (gesture) {
    // Hide the artwork's hanging forearm on the gesture's side(s): the torso paths are
    // everything between the defs and the first head-part <use>.
    const bodyStart = out.indexOf("<path", out.indexOf("</defs>"));
    const bodyEnd = out.indexOf("<use ", bodyStart);
    out = `${out.slice(0, bodyStart)}<g mask="url(#peep-armcut)">${out.slice(bodyStart, bodyEnd)}</g>${out.slice(bodyEnd)}`;
    out = out.replace("</defs>", `${armCutMaskDef(gesture.sides)}</defs>`);
    if (gesture.layer === "behind") behind = gestureSvg(peep.gesture, look);
    else front = gestureSvg(peep.gesture, look);
  }
  // Hands (the artwork's arms just end in open stubs) go on top of the torso, just before
  // the head parts; inside DiceBear's own flip group, so they mirror with the figure.
  out = out.replace("<use ", `${handsSvg(look, gesture?.sides ?? [])}${front}<use `);
  // Legs and tucked-behind arms sit beneath the torso, outside that group, so they get
  // the same mirror by hand.
  const underlay = behind + (pose.legs ? legsSvg(pose.key, look) : "");
  if (underlay) out = out.replace("</defs>", `</defs>${peep.flip ? `<g transform="translate(704, 0) scale(-1, 1)">${underlay}</g>` : underlay}`);
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
  return { file: new File([blob], PEEP_ASSET_FILENAME, { type: "image/png" }), aspect: width / height };
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
  initialPeep,
  submitLabel = "Add to reel",
}: {
  placingKey: string | null;
  // `aspect` is the cropped artwork's width/height, so it is placed unsquashed.
  // `peep` is this character's settings, stored on the overlay so it can be edited again.
  onPlace: (file: File, key: string, aspect: number, peep: Peep) => void;
  // Reopen an existing character (from an overlay's stored settings) instead of a random one.
  initialPeep?: Record<string, unknown>;
  submitLabel?: string;
}) {
  // Merged over a random peep so a settings blob saved by an older version still has every field.
  const [peep, setPeep] = useState<Peep>(() => (initialPeep ? { ...randomPeep(), ...(initialPeep as Partial<Peep>) } : randomPeep()));
  const [activePart, setActivePart] = useState<PartKey>("head");
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<Peep>) => setPeep((previous) => ({ ...previous, ...patch }));
  const [saved, setSaved] = useState<SavedPeep[]>([]);
  const [saveName, setSaveName] = useState("");
  // Read after mount: localStorage doesn't exist during server rendering.
  useEffect(() => setSaved(readSavedPeeps()), []);

  function handleSave() {
    const name = saveName.trim();
    if (!name) return;
    const next = [...saved.filter((s) => s.name !== name), { name, peep }];
    setSaved(next);
    writeSavedPeeps(next);
  }

  function handleDeleteSaved(name: string) {
    const next = saved.filter((s) => s.name !== name);
    setSaved(next);
    writeSavedPeeps(next);
  }

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
      .then(({ file, aspect }) => onPlace(file, "peep", aspect, peep))
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
          {isPlacing ? "Working…" : submitLabel}
        </button>
        {error && <p className="text-[11px] text-red-600">{error}</p>}
        <div className="flex flex-col gap-1 rounded-md border border-border p-1.5">
          <span className="text-[11px] text-muted">My peeps</span>
          <div className="flex gap-1">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              placeholder="Name this peep"
              maxLength={30}
              className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 text-[11px]"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={!saveName.trim()}
              className="rounded border border-border px-1.5 text-[11px] hover:border-accent disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {saved.length > 0 && (
            <ul className="flex max-h-28 flex-col gap-0.5 overflow-y-auto">
              {saved.map((s) => (
                <li key={s.name} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setPeep(s.peep);
                      setSaveName(s.name);
                    }}
                    title="Load this peep"
                    className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-black/5"
                  >
                    {s.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteSaved(s.name)}
                    aria-label={`Delete ${s.name}`}
                    className="px-1 text-[11px] text-muted hover:text-red-600"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-[10px] text-muted">
          Placed like a prop: drag, resize and trim it on the time bar. Double-click it in the preview to edit its parts
          again. Art: Open Peeps by Pablo Stanley (CC0).
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
