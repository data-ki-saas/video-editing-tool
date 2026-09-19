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

// A fourth column, to the right of the mouth-shape column -- the 4 curated
// mood-driven eyebrow shapes (see skin.ts's AvatarSkinExpressionShape and
// library.ts's MOOD_EXPRESSION_SHAPES), stacked vertically the same way the
// two mouth shapes are. All 4 shapes share one rect size so library.ts's
// single "eyebrows" part pivot keeps them aligned to each other regardless
// of which is active (same convention the mouth shapes already use).
// Positioned/sized well short of HEAD_RECT's own height, so this column
// (like the mouth column) has no effect on ROW2_Y below.
const EYEBROWS_COLUMN_X = MOUTH_CLOSED_RECT.sx + MOUTH_CLOSED_RECT.sWidth + GAP;
const EYEBROWS_WIDTH = 60;
const EYEBROWS_HEIGHT = 16;
const EYEBROWS_NEUTRAL_RECT: AtlasRect = { sx: EYEBROWS_COLUMN_X, sy: GAP, sWidth: EYEBROWS_WIDTH, sHeight: EYEBROWS_HEIGHT };
const EYEBROWS_ANGRY_RECT: AtlasRect = { sx: EYEBROWS_COLUMN_X, sy: EYEBROWS_NEUTRAL_RECT.sy + EYEBROWS_HEIGHT + GAP, sWidth: EYEBROWS_WIDTH, sHeight: EYEBROWS_HEIGHT };
const EYEBROWS_HAPPY_RECT: AtlasRect = { sx: EYEBROWS_COLUMN_X, sy: EYEBROWS_ANGRY_RECT.sy + EYEBROWS_HEIGHT + GAP, sWidth: EYEBROWS_WIDTH, sHeight: EYEBROWS_HEIGHT };
const EYEBROWS_SAD_RECT: AtlasRect = { sx: EYEBROWS_COLUMN_X, sy: EYEBROWS_HAPPY_RECT.sy + EYEBROWS_HEIGHT + GAP, sWidth: EYEBROWS_WIDTH, sHeight: EYEBROWS_HEIGHT };

// A fifth column, to the right of the eyebrows column -- the two blink
// states (see actions.ts's computeEyeShapeId), previously baked directly
// into HEAD_RECT (see drawHead's own doc comment below) and now their own
// swappable rect for the same reason mouth/eyebrows are: something needs to
// animate them independently, every frame.
const EYES_COLUMN_X = EYEBROWS_COLUMN_X + EYEBROWS_WIDTH + GAP;
const EYES_WIDTH = 60;
const EYES_HEIGHT = 20;
const EYES_OPEN_RECT: AtlasRect = { sx: EYES_COLUMN_X, sy: GAP, sWidth: EYES_WIDTH, sHeight: EYES_HEIGHT };
const EYES_CLOSED_RECT: AtlasRect = { sx: EYES_COLUMN_X, sy: EYES_OPEN_RECT.sy + EYES_HEIGHT + GAP, sWidth: EYES_WIDTH, sHeight: EYES_HEIGHT };

// Row 2 -- torso, then both arms, then both legs, left to right. Row starts
// below the tallest thing in row 1 (the head).
const ROW2_Y = HEAD_RECT.sy + HEAD_RECT.sHeight + GAP;
const TORSO_RECT: AtlasRect = { sx: GAP, sy: ROW2_Y, sWidth: 120, sHeight: 140 };
const ARM_L_RECT: AtlasRect = { sx: TORSO_RECT.sx + TORSO_RECT.sWidth + GAP, sy: ROW2_Y, sWidth: 36, sHeight: 130 };
const ARM_R_RECT: AtlasRect = { sx: ARM_L_RECT.sx + ARM_L_RECT.sWidth + GAP, sy: ROW2_Y, sWidth: 36, sHeight: 130 };
const LEG_L_RECT: AtlasRect = { sx: ARM_R_RECT.sx + ARM_R_RECT.sWidth + GAP, sy: ROW2_Y, sWidth: 42, sHeight: 150 };
const LEG_R_RECT: AtlasRect = { sx: LEG_L_RECT.sx + LEG_L_RECT.sWidth + GAP, sy: ROW2_Y, sWidth: 42, sHeight: 150 };

// Row 3 (Phase 8, "selectable torsos") -- three alternate torso silhouettes
// ("polo"/"blazer"/"suit"), each the SAME sWidth/sHeight as TORSO_RECT so a
// picked garment's atlas rect can substitute for the "torso" part's own rect
// with no change to that part's own pivot (skin.ts's AvatarSkinGarmentShape
// doc comment) -- pivot is measured relative to the rect's OWN top-left, so
// a differently-sized rect would need its own pivot too. Extra (2x GAP)
// clearance above this row, not the usual single GAP, because these shapes'
// own collar/lapel details deliberately draw a few px past the rect's own
// top edge (see drawTorsoPolo/drawTorsoSuit below) -- this row starting
// further down is what keeps that overshoot from ever touching Row 2's
// bottom edge.
const ROW3_Y = Math.max(TORSO_RECT.sy + TORSO_RECT.sHeight, LEG_L_RECT.sy + LEG_L_RECT.sHeight) + GAP * 2;
const POLO_RECT: AtlasRect = { sx: GAP, sy: ROW3_Y, sWidth: 120, sHeight: 140 };
const BLAZER_RECT: AtlasRect = { sx: POLO_RECT.sx + POLO_RECT.sWidth + GAP, sy: ROW3_Y, sWidth: 120, sHeight: 140 };
const SUIT_RECT: AtlasRect = { sx: BLAZER_RECT.sx + BLAZER_RECT.sWidth + GAP, sy: ROW3_Y, sWidth: 120, sHeight: 140 };

// Row 4 -- "neck": a plain skin-tone patch riding the SAME bone as "torso"
// (library.ts's PLACEHOLDER_SKIN_PARTS gives it boneIndex=TORSO, same
// convention "mouth" already uses to share HEAD's bone with "head"). Exists
// purely to sit BEHIND the blazer/suit garments' open-collar cutout
// (cutGarmentNotch erases alpha to fully transparent on purpose, so a
// recolor never fills it back in -- see that function's own doc comment) --
// without this, that cut has nothing opaque drawn under it, so the collar
// "hole" shows the raw video frame straight through instead of reading as
// an open collar. Sized/pivoted (library.ts's "neck" pivot) so it starts
// just above the bone joint and reaches down past the suit's deepest cut
// (topY+44, cx+-26 -- see drawTorsoSuit above); zOrder places it right
// after "torso" and before "arms"/"head", the same layer a real neck bone
// would occupy.
const ROW4_Y = SUIT_RECT.sy + SUIT_RECT.sHeight + GAP;
const NECK_RECT: AtlasRect = { sx: GAP, sy: ROW4_Y, sWidth: 64, sHeight: 50 };

const CANVAS_WIDTH =
  Math.max(LEG_R_RECT.sx + LEG_R_RECT.sWidth, SUIT_RECT.sx + SUIT_RECT.sWidth, EYES_OPEN_RECT.sx + EYES_OPEN_RECT.sWidth) + GAP;
const CANVAS_HEIGHT = NECK_RECT.sy + NECK_RECT.sHeight + GAP;

// Flat, pleasant placeholder colors -- this is explicitly not meant to look
// polished, just to read unambiguously as "a simple person" with cleanly
// separated parts.
const SKIN_TONE = "#e8b48c";
const SHIRT_COLOR = "#3f6fb0";
const PANTS_COLOR = "#2b2b3d";
const EYE_COLOR = "#2a2a2a";
const EYEBROW_COLOR = "#3a2a1f";
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

/** The plain rounded-rect torso body every garment variant below starts
 * from -- exactly what TORSO_RECT ("plain shirt") has always drawn, pulled
 * into its own function so drawTorsoPolo/Blazer/Suit can reuse it rather
 * than duplicating the same three drawRoundedRect args three more times. */
function drawTorsoBody(ctx: CanvasRenderingContext2D, rect: AtlasRect, palette: PlaceholderAtlasPalette): void {
  drawRoundedRect(ctx, rect.sx + 6, rect.sy + 6, rect.sWidth - 12, rect.sHeight - 12, 14, palette.shirtColor);
}

/** Fills+strokes one filled triangle in the shirt's own color -- used by
 * drawTorsoPolo (collar points)/drawTorsoSuit (lapel wedges) to ADD to the
 * plain body's silhouette. Deliberately always `palette.shirtColor`, never a
 * second contrasting color: compile.ts's colorSlotOverrides recolor
 * (recolorAtlas) re-tints a WHOLE target rect uniformly wherever it isn't
 * fully transparent, so any internal color contrast drawn here would just
 * get flattened away the moment a creator picks a non-default shirt color --
 * only a SILHOUETTE difference (added or cut-away area) survives that
 * recolor, which is exactly what distinguishes these four garments from each
 * other and from the plain shirt. */
function fillGarmentTriangle(ctx: CanvasRenderingContext2D, points: [number, number][], palette: PlaceholderAtlasPalette): void {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = palette.shirtColor;
  ctx.fill();
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** Cuts a triangular, fully-transparent notch out of whatever's already
 * drawn -- `destination-out` erases alpha rather than painting a color, so
 * (unlike fillGarmentTriangle) this survives a colorSlotOverrides recolor
 * exactly as drawn: an open collar stays open no matter what shirt color is
 * picked. A thin outline traced back in normal composite mode afterward
 * gives the cut a visible edge instead of a bare hard-alpha cliff. */
function cutGarmentNotch(ctx: CanvasRenderingContext2D, points: [number, number][]): void {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** "Polo" -- the plain shirt body plus two small collar-point triangles
 * poking up from the neckline, same shirtColor as the body (see
 * fillGarmentTriangle's own doc comment on why). */
function drawTorsoPolo(ctx: CanvasRenderingContext2D, rect: AtlasRect, palette: PlaceholderAtlasPalette): void {
  ctx.save();
  ctx.beginPath();
  // Widened GAP px above the rect's own top edge -- the collar/lapel details
  // below deliberately poke a few px past `rect.sy` itself (see this
  // function's own coordinates), and a clip at EXACTLY rect.sy would crop
  // that overshoot flat, erasing the very feature it's meant to draw. GAP is
  // well inside the GAP*2 clearance ROW3_Y left above this whole row, so
  // this still can't bleed into Row 2.
  ctx.rect(rect.sx, rect.sy - GAP, rect.sWidth, rect.sHeight + GAP);
  ctx.clip();
  drawTorsoBody(ctx, rect, palette);
  const cx = rect.sx + rect.sWidth / 2;
  const topY = rect.sy + 6;
  fillGarmentTriangle(
    ctx,
    [
      [cx - 30, topY],
      [cx - 10, topY - 12],
      [cx - 6, topY],
    ],
    palette
  );
  fillGarmentTriangle(
    ctx,
    [
      [cx + 30, topY],
      [cx + 10, topY - 12],
      [cx + 6, topY],
    ],
    palette
  );
  ctx.restore();
}

/** "Blazer" -- the plain shirt body with an open, V-shaped collar notch cut
 * into the top-center (see cutGarmentNotch's own doc comment). */
function drawTorsoBlazer(ctx: CanvasRenderingContext2D, rect: AtlasRect, palette: PlaceholderAtlasPalette): void {
  ctx.save();
  ctx.beginPath();
  // Widened GAP px above the rect's own top edge -- the collar/lapel details
  // below deliberately poke a few px past `rect.sy` itself (see this
  // function's own coordinates), and a clip at EXACTLY rect.sy would crop
  // that overshoot flat, erasing the very feature it's meant to draw. GAP is
  // well inside the GAP*2 clearance ROW3_Y left above this whole row, so
  // this still can't bleed into Row 2.
  ctx.rect(rect.sx, rect.sy - GAP, rect.sWidth, rect.sHeight + GAP);
  ctx.clip();
  drawTorsoBody(ctx, rect, palette);
  const cx = rect.sx + rect.sWidth / 2;
  const topY = rect.sy + 6;
  cutGarmentNotch(
    ctx,
    [
      [cx - 20, topY],
      [cx, topY + 30],
      [cx + 20, topY],
    ]
  );
  ctx.restore();
}

/** "Suit" -- blazer's open collar notch, cut DEEPER, plus two small peaked-
 * lapel triangles added at the shoulders -- both a bigger cut-away AND an
 * added silhouette bump, reading as more structured/formal than a bare
 * blazer at this size. */
function drawTorsoSuit(ctx: CanvasRenderingContext2D, rect: AtlasRect, palette: PlaceholderAtlasPalette): void {
  ctx.save();
  ctx.beginPath();
  // Widened GAP px above the rect's own top edge -- the collar/lapel details
  // below deliberately poke a few px past `rect.sy` itself (see this
  // function's own coordinates), and a clip at EXACTLY rect.sy would crop
  // that overshoot flat, erasing the very feature it's meant to draw. GAP is
  // well inside the GAP*2 clearance ROW3_Y left above this whole row, so
  // this still can't bleed into Row 2.
  ctx.rect(rect.sx, rect.sy - GAP, rect.sWidth, rect.sHeight + GAP);
  ctx.clip();
  drawTorsoBody(ctx, rect, palette);
  const cx = rect.sx + rect.sWidth / 2;
  const topY = rect.sy + 6;
  fillGarmentTriangle(
    ctx,
    [
      [rect.sx + 8, topY + 18],
      [rect.sx + 8, topY - 6],
      [cx - 16, topY],
    ],
    palette
  );
  fillGarmentTriangle(
    ctx,
    [
      [rect.sx + rect.sWidth - 8, topY + 18],
      [rect.sx + rect.sWidth - 8, topY - 6],
      [cx + 16, topY],
    ],
    palette
  );
  cutGarmentNotch(
    ctx,
    [
      [cx - 26, topY],
      [cx, topY + 44],
      [cx + 26, topY],
    ]
  );
  ctx.restore();
}

/** Plain skin-tone patch for the "neck" part -- see NECK_RECT's own doc
 * comment above for why this exists (backing the blazer/suit collar
 * cutout). Mirrors atlas_builder.py's `_draw_neck`. */
function drawNeck(ctx: CanvasRenderingContext2D, rect: AtlasRect, palette: PlaceholderAtlasPalette): void {
  drawRoundedRect(ctx, rect.sx + 4, rect.sy + 4, rect.sWidth - 8, rect.sHeight - 8, 10, palette.skinTone);
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
}

// Eye dot geometry, shared between drawEyesOpen/drawEyesClosed below so both
// shapes stay aligned to each other (same convention drawMouthClosed/Open's
// own shared centerX/centerY already use) -- these are the exact offsets the
// eyes used to be baked into HEAD_RECT with, now reproduced inside their own
// small rect instead (see library.ts's "eyes" part pivot for how that rect
// is repositioned back onto the same on-screen spot).
const EYE_DOT_OFFSET_X = 20;
const EYE_DOT_RADIUS = 7;

function drawEyesOpen(ctx: CanvasRenderingContext2D, rect: AtlasRect): void {
  const centerX = rect.sx + rect.sWidth / 2;
  const centerY = rect.sy + rect.sHeight / 2;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(centerX + sign * EYE_DOT_OFFSET_X, centerY, EYE_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = EYE_COLOR;
    ctx.fill();
  }
}

function drawEyesClosed(ctx: CanvasRenderingContext2D, rect: AtlasRect): void {
  const centerX = rect.sx + rect.sWidth / 2;
  const centerY = rect.sy + rect.sHeight / 2;
  ctx.strokeStyle = EYE_COLOR;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (const sign of [-1, 1]) {
    const midX = centerX + sign * EYE_DOT_OFFSET_X;
    ctx.beginPath();
    ctx.moveTo(midX - EYE_DOT_RADIUS, centerY);
    ctx.quadraticCurveTo(midX, centerY + 2, midX + EYE_DOT_RADIUS, centerY);
    ctx.stroke();
  }
}

/** Draws one mirrored pair of eyebrow strokes into `rect` -- shared by all 4
 * curated shapes below, which differ only in `innerY`/`outerY` (the two
 * strokes' own left/right ANGLED endpoints, before mirroring): `innerY` is
 * the end nearer the nose-bridge (center), `outerY` the end nearer the
 * temple. Both are offsets from the rect's own vertical center -- negative
 * is UP (canvas convention), so e.g. angry's innerY > outerY droops the
 * inner corners down and pulls them together, the classic furrowed look.
 * Mirrors the same `for (const sign of [-1, 1])` convention drawHead's own
 * (baked) eye dots already use, so left/right symmetry is never hand-typed
 * twice. */
function drawEyebrowPair(ctx: CanvasRenderingContext2D, rect: AtlasRect, innerY: number, outerY: number, midY: number): void {
  const centerX = rect.sx + rect.sWidth / 2;
  const centerY = rect.sy + rect.sHeight / 2;
  const browSpan = 18; // half-width of one eyebrow stroke
  const browOffsetX = 20; // distance from center to each eyebrow's own midpoint -- matches EYES_RECT's own eye spacing
  ctx.lineCap = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = EYEBROW_COLOR;
  for (const sign of [-1, 1]) {
    const midX = centerX + sign * browOffsetX;
    const innerX = midX - sign * browSpan; // nearer the nose bridge
    const outerX = midX + sign * browSpan; // nearer the temple
    ctx.beginPath();
    ctx.moveTo(innerX, centerY + innerY);
    ctx.quadraticCurveTo(midX, centerY + midY, outerX, centerY + outerY);
    ctx.stroke();
  }
}

function drawEyebrowsNeutral(ctx: CanvasRenderingContext2D, rect: AtlasRect): void {
  drawEyebrowPair(ctx, rect, 0, 0, -1);
}

function drawEyebrowsAngry(ctx: CanvasRenderingContext2D, rect: AtlasRect): void {
  // Inner corners pulled down and together, outer ends raised -- furrowed.
  drawEyebrowPair(ctx, rect, 4, -4, 1);
}

function drawEyebrowsHappy(ctx: CanvasRenderingContext2D, rect: AtlasRect): void {
  // A gentle upward arch across the whole brow -- raised/open look.
  drawEyebrowPair(ctx, rect, 1, 1, -5);
}

function drawEyebrowsSad(ctx: CanvasRenderingContext2D, rect: AtlasRect): void {
  // Opposite of angry -- inner corners raised, outer ends drooping.
  drawEyebrowPair(ctx, rect, -4, 4, -1);
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
 * differs. `resolvedPalette` (the merged palette actually drawn with) lets a
 * caller (library.ts's buildSeedSkin) build accurate `AvatarSkinColorSlot`
 * `defaultColor`s without re-deriving/duplicating DEFAULT_PALETTE's own
 * values a second time. */
export function buildPlaceholderAtlas(
  paletteOverrides: Partial<PlaceholderAtlasPalette> = {}
): { dataUrl: string; partRects: Record<string, AtlasRect>; resolvedPalette: PlaceholderAtlasPalette } {
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
    // The "eyebrows" slot's own base rect is "neutral" -- see
    // EXPRESSION_SHAPES's own doc comment in library.ts for why that's a
    // deliberate choice, not an arbitrary default.
    eyebrows: EYEBROWS_NEUTRAL_RECT,
    neutral: EYEBROWS_NEUTRAL_RECT,
    angry: EYEBROWS_ANGRY_RECT,
    happy: EYEBROWS_HAPPY_RECT,
    sad: EYEBROWS_SAD_RECT,
    // The "eyes" slot's own base rect is "eyeOpen" -- same "base rect IS the
    // default shape" convention as "eyebrows"/"neutral" above. Named
    // "eyeOpen"/"eyeClosed" rather than plain "open"/"closed" -- this atlas's
    // `partRects` is ONE flat namespace shared by every part's shapes
    // (skin.ts's own doc comment), and "mouth" already owns those two ids.
    eyes: EYES_OPEN_RECT,
    eyeOpen: EYES_OPEN_RECT,
    eyeClosed: EYES_CLOSED_RECT,
    torso: TORSO_RECT,
    armL: ARM_L_RECT,
    armR: ARM_R_RECT,
    legL: LEG_L_RECT,
    legR: LEG_R_RECT,
    // Phase 8 ("selectable torsos") -- additional swappable rects for the
    // "torso" part slot, same pattern as "open"/"closed" above for "mouth".
    polo: POLO_RECT,
    blazer: BLAZER_RECT,
    suit: SUIT_RECT,
    neck: NECK_RECT,
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
    return { dataUrl: "", partRects, resolvedPalette: palette };
  }

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("buildPlaceholderAtlas: 2D context unavailable");

  drawHead(ctx, HEAD_RECT, palette);
  drawMouthClosed(ctx, MOUTH_CLOSED_RECT, palette);
  drawMouthOpen(ctx, MOUTH_OPEN_RECT, palette);
  drawEyebrowsNeutral(ctx, EYEBROWS_NEUTRAL_RECT);
  drawEyebrowsAngry(ctx, EYEBROWS_ANGRY_RECT);
  drawEyebrowsHappy(ctx, EYEBROWS_HAPPY_RECT);
  drawEyebrowsSad(ctx, EYEBROWS_SAD_RECT);
  drawEyesOpen(ctx, EYES_OPEN_RECT);
  drawEyesClosed(ctx, EYES_CLOSED_RECT);
  drawTorsoBody(ctx, TORSO_RECT, palette);
  drawRoundedRect(ctx, ARM_L_RECT.sx + 4, ARM_L_RECT.sy + 4, ARM_L_RECT.sWidth - 8, ARM_L_RECT.sHeight - 8, 14, palette.skinTone);
  drawRoundedRect(ctx, ARM_R_RECT.sx + 4, ARM_R_RECT.sy + 4, ARM_R_RECT.sWidth - 8, ARM_R_RECT.sHeight - 8, 14, palette.skinTone);
  drawRoundedRect(ctx, LEG_L_RECT.sx + 4, LEG_L_RECT.sy + 4, LEG_L_RECT.sWidth - 8, LEG_L_RECT.sHeight - 8, 17, palette.pantsColor);
  drawRoundedRect(ctx, LEG_R_RECT.sx + 4, LEG_R_RECT.sy + 4, LEG_R_RECT.sWidth - 8, LEG_R_RECT.sHeight - 8, 17, palette.pantsColor);
  drawTorsoPolo(ctx, POLO_RECT, palette);
  drawTorsoBlazer(ctx, BLAZER_RECT, palette);
  drawTorsoSuit(ctx, SUIT_RECT, palette);
  drawNeck(ctx, NECK_RECT, palette);

  return { dataUrl: canvas.toDataURL("image/png"), partRects, resolvedPalette: palette };
}
