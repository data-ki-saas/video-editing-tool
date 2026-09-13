/**
 * Procedurally draws a placeholder cartoon biped into one packed atlas
 * canvas and returns it as a `data:` URL -- this is NOT real character art,
 * it exists purely to prove the whole pipeline (rig -> actions -> compile ->
 * render -> export) end to end without waiting on an artist. Every seed skin
 * in library.ts ("placeholder-v1" and its recolored siblings) is built
 * entirely from this function's output, one call per skin with its own
 * palette (see PlaceholderAtlasPalette below); swapping in real art later
 * means replacing the `imageRef` + `partRects` those skins use, nothing about
 * the rig or the renderer.
 *
 * Packing is a fixed, hand-laid-out grid (two shelves: head + both mouth
 * shapes on the first, torso + limbs on the second) -- with only ~9 parts
 * this needs no real bin-packing algorithm, just enough of a gap between
 * adjacent rects that antialiased edges never bleed a stray pixel from one
 * part's rect into its neighbor's sample region.
 */
import type { AtlasRect } from "./skin";

const GAP = 8; // spacing between adjacent packed rects, see this file's own doc comment

// Row 1 -- head (with eyes baked directly into it) plus both separately-
// packed mouth-shape rects (see topology.ts/skin.ts's own doc comments on
// why "talk" swaps a whole rect rather than redrawing a mouth every frame).
const HEAD_RECT: AtlasRect = { sx: GAP, sy: GAP, sWidth: 140, sHeight: 140 };
const MOUTH_CLOSED_RECT: AtlasRect = { sx: HEAD_RECT.sx + HEAD_RECT.sWidth + GAP, sy: GAP, sWidth: 50, sHeight: 28 };
const MOUTH_OPEN_RECT: AtlasRect = { sx: MOUTH_CLOSED_RECT.sx, sy: MOUTH_CLOSED_RECT.sy + MOUTH_CLOSED_RECT.sHeight + GAP, sWidth: 50, sHeight: 28 };

// Row 2 -- torso, then both arms, then both legs, left to right. Row starts
// below the tallest thing in row 1 (the head).
const ROW2_Y = HEAD_RECT.sy + HEAD_RECT.sHeight + GAP;
const TORSO_RECT: AtlasRect = { sx: GAP, sy: ROW2_Y, sWidth: 120, sHeight: 140 };
const ARM_L_RECT: AtlasRect = { sx: TORSO_RECT.sx + TORSO_RECT.sWidth + GAP, sy: ROW2_Y, sWidth: 36, sHeight: 130 };
const ARM_R_RECT: AtlasRect = { sx: ARM_L_RECT.sx + ARM_L_RECT.sWidth + GAP, sy: ROW2_Y, sWidth: 36, sHeight: 130 };
const LEG_L_RECT: AtlasRect = { sx: ARM_R_RECT.sx + ARM_R_RECT.sWidth + GAP, sy: ROW2_Y, sWidth: 42, sHeight: 150 };
const LEG_R_RECT: AtlasRect = { sx: LEG_L_RECT.sx + LEG_L_RECT.sWidth + GAP, sy: ROW2_Y, sWidth: 42, sHeight: 150 };

const CANVAS_WIDTH = LEG_R_RECT.sx + LEG_R_RECT.sWidth + GAP;
const CANVAS_HEIGHT = Math.max(TORSO_RECT.sy + TORSO_RECT.sHeight, LEG_L_RECT.sy + LEG_L_RECT.sHeight) + GAP;

// Flat, pleasant placeholder colors -- this is explicitly not meant to look
// polished, just to read unambiguously as "a simple person" with cleanly
// separated parts.
const SKIN_TONE = "#e8b48c";
const SHIRT_COLOR = "#3f6fb0";
const PANTS_COLOR = "#2b2b3d";
const EYE_COLOR = "#2a2a2a";
const MOUTH_COLOR = "#7a2f2f";
const OUTLINE_COLOR = "rgba(0,0,0,0.18)";

/**
 * The subset of this file's colors that actually vary seed-character to
 * seed-character (library.ts's Phase 5 second/third skin) -- eye/outline
 * color stay fixed module constants above since nothing needs those to
 * differ yet. `hairColor` is optional (not part of DEFAULT_PALETTE below) so
 * the original "Sam" skin's bald look stays pixel-identical when no palette
 * is passed at all, rather than every existing caller needing an update.
 */
export interface PlaceholderAtlasPalette {
  skinTone: string;
  shirtColor: string;
  pantsColor: string;
  mouthColor: string;
  hairColor?: string;
}

const DEFAULT_PALETTE: PlaceholderAtlasPalette = {
  skinTone: SKIN_TONE,
  shirtColor: SHIRT_COLOR,
  pantsColor: PANTS_COLOR,
  mouthColor: MOUTH_COLOR,
};

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, fill: string): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawHead(ctx: CanvasRenderingContext2D, rect: AtlasRect, palette: PlaceholderAtlasPalette): void {
  const centerX = rect.sx + rect.sWidth / 2;
  const centerY = rect.sy + rect.sHeight / 2;
  const radius = rect.sWidth / 2 - 12;

  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fillStyle = palette.skinTone;
  ctx.fill();
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = 2;
  ctx.stroke();

  // A simple clipped "cap" over the top of the head -- the cheapest possible
  // way for a second/third seed skin to read as a visibly different
  // character rather than a recolored clone, without a real hairline/strand
  // art pass. Clipped to the head circle so it can never spill past it
  // regardless of the ellipse's own size. Skipped entirely when no
  // hairColor is given (see PlaceholderAtlasPalette's own doc comment).
  if (palette.hairColor) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(centerX, centerY - radius * 0.35, radius * 1.05, radius * 0.75, 0, Math.PI, Math.PI * 2);
    ctx.fillStyle = palette.hairColor;
    ctx.fill();
    ctx.restore();
  }

  // Two simple dot eyes, baked directly into the head part (per this
  // feature's spec -- eyes are never a separate swappable part the way the
  // mouth is, since nothing needs to animate them independently in this
  // phase).
  const eyeOffsetX = 20;
  const eyeOffsetY = 8;
  const eyeRadius = 7;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(centerX + sign * eyeOffsetX, centerY - eyeOffsetY, eyeRadius, 0, Math.PI * 2);
    ctx.fillStyle = EYE_COLOR;
    ctx.fill();
  }
}

function drawMouthClosed(ctx: CanvasRenderingContext2D, rect: AtlasRect, palette: PlaceholderAtlasPalette): void {
  const centerX = rect.sx + rect.sWidth / 2;
  const centerY = rect.sy + rect.sHeight / 2;
  ctx.beginPath();
  ctx.ellipse(centerX, centerY, 15, 3, 0, 0, Math.PI * 2);
  ctx.fillStyle = palette.mouthColor;
  ctx.fill();
}

function drawMouthOpen(ctx: CanvasRenderingContext2D, rect: AtlasRect, palette: PlaceholderAtlasPalette): void {
  const centerX = rect.sx + rect.sWidth / 2;
  const centerY = rect.sy + rect.sHeight / 2;
  ctx.beginPath();
  ctx.ellipse(centerX, centerY, 11, 9, 0, 0, Math.PI * 2);
  ctx.fillStyle = palette.mouthColor;
  ctx.fill();
}

/** Builds one packed placeholder atlas image plus every part/mouth-shape rect
 * drawn into it -- library.ts's seed skins are each built directly from one
 * call's return value. `paletteOverrides` lets a second/third seed skin
 * (Phase 5) reuse this exact same procedural drawing rather than needing its
 * own draw pipeline; omitting it entirely (as `placeholder-v1`/"Sam" does)
 * reproduces the original palette exactly, since DEFAULT_PALETTE carries no
 * hairColor. The returned `partRects` are identical across every call
 * (packing is fixed layout math, not palette-dependent) -- only `dataUrl`
 * differs. */
export function buildPlaceholderAtlas(paletteOverrides: Partial<PlaceholderAtlasPalette> = {}): { dataUrl: string; partRects: Record<string, AtlasRect> } {
  const palette: PlaceholderAtlasPalette = { ...DEFAULT_PALETTE, ...paletteOverrides };
  const partRects: Record<string, AtlasRect> = {
    head: HEAD_RECT,
    // The mouth "slot" part (see skin.ts's AvatarSkinMouthShape doc
    // comment) needs its own base rect too -- reusing "closed" is a
    // sensible, never-really-drawn-directly default (drawAvatar always
    // substitutes whichever of "open"/"closed" actions.ts's
    // computeMouthShapeId picks for the current frame instead).
    mouth: MOUTH_CLOSED_RECT,
    closed: MOUTH_CLOSED_RECT,
    open: MOUTH_OPEN_RECT,
    torso: TORSO_RECT,
    armL: ARM_L_RECT,
    armR: ARM_R_RECT,
    legL: LEG_L_RECT,
    legR: LEG_R_RECT,
  };

  // `document` doesn't exist outside a browser. library.ts calls this
  // function eagerly at MODULE SCOPE (`const placeholderAtlas =
  // buildPlaceholderAtlas();`), which runs the instant anything imports
  // library.ts -- and that import graph is reachable from "use client"
  // files (CanvasPlayer.tsx, AvatarFramingDialog.tsx, AvatarOverlayTrack.tsx)
  // that Next.js still evaluates on the SERVER for the initial SSR render of
  // /dashboard/[projectId] (client components are SSR'd once before
  // hydration -- only *effects* are skipped server-side, not module-level
  // code). Every real consumer of this atlas image (getCompiledAvatar's
  // decode, via compile.ts) only ever runs inside a client-side effect or
  // event handler, never at import time -- so returning a real partRects map
  // (plain arithmetic above, no DOM needed) with an empty dataUrl here is
  // enough to keep that unconditional import from throwing
  // "document is not defined" on the server; nothing server-side ever
  // actually decodes or draws this dataUrl.
  if (typeof document === "undefined") {
    return { dataUrl: "", partRects };
  }

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("buildPlaceholderAtlas: 2D context unavailable");

  drawHead(ctx, HEAD_RECT, palette);
  drawMouthClosed(ctx, MOUTH_CLOSED_RECT, palette);
  drawMouthOpen(ctx, MOUTH_OPEN_RECT, palette);
  drawRoundedRect(ctx, TORSO_RECT.sx + 6, TORSO_RECT.sy + 6, TORSO_RECT.sWidth - 12, TORSO_RECT.sHeight - 12, 14, palette.shirtColor);
  drawRoundedRect(ctx, ARM_L_RECT.sx + 4, ARM_L_RECT.sy + 4, ARM_L_RECT.sWidth - 8, ARM_L_RECT.sHeight - 8, 14, palette.skinTone);
  drawRoundedRect(ctx, ARM_R_RECT.sx + 4, ARM_R_RECT.sy + 4, ARM_R_RECT.sWidth - 8, ARM_R_RECT.sHeight - 8, 14, palette.skinTone);
  drawRoundedRect(ctx, LEG_L_RECT.sx + 4, LEG_L_RECT.sy + 4, LEG_L_RECT.sWidth - 8, LEG_L_RECT.sHeight - 8, 17, palette.pantsColor);
  drawRoundedRect(ctx, LEG_R_RECT.sx + 4, LEG_R_RECT.sy + 4, LEG_R_RECT.sWidth - 8, LEG_R_RECT.sHeight - 8, 17, palette.pantsColor);

  return { dataUrl: canvas.toDataURL("image/png"), partRects };
}
