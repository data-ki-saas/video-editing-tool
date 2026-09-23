/**
 * The Phase 7 accessory catalog -- small procedurally-drawn attachments
 * (sunglasses, a hat) a creator can add via a concrete edit ("add
 * sunglasses", edits.ts's "addAccessory" op) or by hand-authoring a Design's
 * `attachedAccessories` (design.ts). Each entry attaches at one of the owning
 * Topology's `anchors` (topology.ts) -- `anchorId` here MUST match a real
 * anchor id on whichever topology an avatar rides (today, only
 * "biped-simple"'s "head"/"handL"/"handR", see library.ts), and compile.ts's
 * compileAccessories throws if a Design references a mismatched pair, same
 * "fail loudly at the boundary" posture as every other cross-reference this
 * engine validates.
 *
 * Same procedural-canvas-art posture as placeholderAtlas.ts (this is NOT
 * real character art, just enough to prove the mechanism end to end) --
 * `draw` renders directly into a small canvas, cached as a decoded
 * HTMLImageElement per (accessoryAssetId, resolved color) pair so repeatedly
 * compiling the same accessory (e.g. two clips using the same avatar+
 * accessory) never redraws or re-decodes it twice.
 */

export interface AccessoryCatalogEntry {
  accessoryAssetId: string;
  name: string;
  // Which of the owning Topology's `anchors` (topology.ts) this rides.
  anchorId: string;
  // Fine per-accessory adjustment layered ON TOP of the anchor's own
  // `localOffset` -- lets more than one accessory share a single anchor
  // (e.g. both a hat and sunglasses riding "head") while each landing at its
  // own sensible spot, without needing a separate anchor per accessory kind.
  offsetFromAnchor: { x: number; y: number };
  width: number;
  height: number;
  // Where, within this accessory's own drawn image, the anchor's world
  // position should land -- same pivot convention as AvatarSkinPart's own
  // pivotX/pivotY (skin.ts).
  pivotX: number;
  pivotY: number;
  // Static rest angle (degrees, clockwise) applied around the pivot, ON TOP
  // of whatever rotation the accessory's own anchor bone already carries
  // (renderer.ts's drawAvatar loop) -- e.g. a held prop drawn horizontally
  // in its own little canvas still needs a natural ~diagonal grip angle at
  // rest. Symmetric head-anchored accessories (hat/sunglasses) don't need
  // this, hence optional / defaults to 0.
  rotationDegrees?: number;
  // Other anchors (besides the primary `anchorId` above) this SAME entry
  // may also attach to -- e.g. a held prop's own offsetFromAnchor/pivot/
  // rotationDegrees work identically whichever hand it's in, since
  // library.ts's handL/handR anchors are geometrically symmetric (same
  // localOffset, no mirrored scale on either arm bone), so a prop doesn't
  // need a second catalog entry just to be equippable on the other hand --
  // see accessoryAcceptsAnchor below, the one place this is actually
  // consulted (compile.ts/edits.ts validation, AvatarFramingDialog's hand
  // picker).
  alternateAnchorIds?: string[];
  // Radians, additive onto the arm bone owning this accessory's actual
  // attached anchor, applied continuously as part of the BASE posture pose
  // (actions.ts's applyHeldAccessoryPoseBias) -- a default "how is this held"
  // arm position, distinct from `rotationDegrees` above (which only spins
  // the accessory's own sprite around its pivot, not the arm underneath it).
  // Always authored as if for "handR" -- compile.ts's compileAccessories
  // negates it automatically when the actual attached anchor is "handL",
  // same mirroring convention library.ts's POINT_LEFT/POINT_RIGHT already
  // use for a single-arm gesture. Optional: every prop that just rests at
  // the hand's own default position (pen/knife/gun/stick/money/wallet/
  // creditCard) omits this entirely, same as they've always worked. Because
  // this is base-POSTURE-level (not a gesture), any gesture later targeting
  // the same arm bone still fully overrides it (mergeBoneOverride in
  // actions.ts) -- e.g. a future "reach the mic out" gesture is not fought
  // by this default, it simply wins outright while active.
  restPoseArmRotationRadians?: number;
  defaultColor: string;
  draw: (ctx: CanvasRenderingContext2D, color: string) => void;
}

/** Whether `entry` may be attached at `anchorId` -- its own primary
 * `anchorId` or any of its `alternateAnchorIds`. The one place that set is
 * actually consulted, so every validator/picker agrees on it. */
export function accessoryAcceptsAnchor(entry: AccessoryCatalogEntry, anchorId: string): boolean {
  return entry.anchorId === anchorId || (entry.alternateAnchorIds?.includes(anchorId) ?? false);
}

function drawSunglasses(ctx: CanvasRenderingContext2D, color: string): void {
  // Two rounded lenses joined by a thin bridge -- centered in the canvas so
  // this entry's own pivotX/pivotY (half its width/height) lands exactly
  // between the lenses, i.e. right where a face's eye-line anchor sits.
  const lensWidth = 34;
  const lensHeight = 24;
  const gap = 10;
  const centerY = ctx.canvas.height / 2;
  const leftX = ctx.canvas.width / 2 - gap / 2 - lensWidth;
  const rightX = ctx.canvas.width / 2 + gap / 2;

  ctx.fillStyle = color;
  for (const x of [leftX, rightX]) {
    ctx.beginPath();
    ctx.roundRect(x, centerY - lensHeight / 2, lensWidth, lensHeight, 8);
    ctx.fill();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(leftX + lensWidth, centerY);
  ctx.lineTo(rightX, centerY);
  ctx.stroke();
}

function drawHat(ctx: CanvasRenderingContext2D, color: string): void {
  // A simple cap: a wide brim plus a rounded crown sitting just above it --
  // pivot (see HAT entry below) sits at the brim's own top edge, center, so
  // the accessory hangs DOWN from the "head" anchor onto the top of the
  // skull, same "attach point sits at one edge, art extends away from it"
  // convention library.ts's own head-part pivot already uses.
  const width = ctx.canvas.width;
  const brimHeight = 10;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, width, brimHeight, 5);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(width * 0.18, brimHeight - 4, width * 0.64, 46, 16);
  ctx.fill();
}

function drawPen(ctx: CanvasRenderingContext2D, color: string): void {
  // A simple ballpoint: rounded barrel + a darker conical tip + a small clip
  // near the cap end -- drawn along the canvas's long (horizontal) axis so
  // PEN's own rotationDegrees can angle the whole thing into a natural grip
  // without needing separately-rotated art.
  const h = ctx.canvas.height;
  const midY = h / 2;
  const barrelLength = ctx.canvas.width - 14;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, midY - h * 0.22, barrelLength, h * 0.44, h * 0.2);
  ctx.fill();

  // Tip (darker, tapered to a point).
  ctx.fillStyle = "#111827";
  ctx.beginPath();
  ctx.moveTo(barrelLength, midY - h * 0.22);
  ctx.lineTo(ctx.canvas.width, midY);
  ctx.lineTo(barrelLength, midY + h * 0.22);
  ctx.closePath();
  ctx.fill();

  // Cap clip.
  ctx.fillStyle = "#111827";
  ctx.fillRect(barrelLength * 0.15, midY - h * 0.5, 3, h * 0.3);
}

function drawKnife(ctx: CanvasRenderingContext2D, color: string): void {
  // Handle (recolorable) + a fixed silver blade -- keeping the blade's own
  // tint fixed (not driven by `color`) so a creator's colorOverride only
  // ever restyles the grip, same "one tint knob, sane fixed rest" posture
  // as drawHat's brim/crown. Drawn along the canvas's long axis, angled at
  // render time via KNIFE's own rotationDegrees.
  const h = ctx.canvas.height;
  const midY = h / 2;
  const handleLength = ctx.canvas.width * 0.32;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, midY - h * 0.28, handleLength, h * 0.56, h * 0.18);
  ctx.fill();

  // Blade: tapered rounded-spine shape ending in a point.
  ctx.fillStyle = "#c7ccd1";
  ctx.beginPath();
  ctx.moveTo(handleLength, midY - h * 0.4);
  ctx.lineTo(ctx.canvas.width - 6, midY - h * 0.06);
  ctx.lineTo(ctx.canvas.width, midY);
  ctx.lineTo(ctx.canvas.width - 6, midY + h * 0.06);
  ctx.lineTo(handleLength, midY + h * 0.4);
  ctx.closePath();
  ctx.fill();
  // Spine highlight line so the blade reads as metal, not a flat wedge.
  ctx.strokeStyle = "#9aa0a6";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(handleLength, midY - h * 0.16);
  ctx.lineTo(ctx.canvas.width - 8, midY - h * 0.02);
  ctx.stroke();
}

function drawGun(ctx: CanvasRenderingContext2D, color: string): void {
  // Deliberately blocky/toylike silhouette -- same stylized, non-photoreal
  // posture as every other procedural accessory here (drawHat/drawSunglasses
  // are simple geometric shapes, not detailed renders). A flat grip + slide
  // + small trigger guard, drawn at rest (barrel angled down, not aiming)
  // since GUN's own default rotationDegrees below picks a relaxed-hold
  // angle rather than a pointed/aiming one.
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  ctx.fillStyle = color;
  // Grip (angled slightly back from the slide, like a real silhouette).
  ctx.beginPath();
  ctx.roundRect(w * 0.04, h * 0.42, w * 0.22, h * 0.56, 4);
  ctx.fill();
  // Slide / barrel.
  ctx.beginPath();
  ctx.roundRect(w * 0.18, h * 0.18, w * 0.78, h * 0.26, 4);
  ctx.fill();
  // Trigger guard (small open loop).
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(w * 0.3, h * 0.5, h * 0.14, 0, Math.PI * 1.4);
  ctx.stroke();
}

function drawMicrophone(ctx: CanvasRenderingContext2D, color: string): void {
  // Handle (recolorable, like drawKnife's grip) + a fixed mesh-textured
  // capsule head -- drawn along the canvas's long axis, angled at render
  // time via MICROPHONE's own rotationDegrees.
  const h = ctx.canvas.height;
  const midY = h / 2;
  const handleLength = ctx.canvas.width * 0.62;
  const headRadius = h * 0.42;
  const headCenterX = ctx.canvas.width - headRadius;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, midY - h * 0.24, handleLength, h * 0.48, h * 0.22);
  ctx.fill();

  // Capsule head (fixed mesh-grey, same "one tint knob" posture as
  // drawKnife's blade -- colorOverride only restyles the handle).
  ctx.fillStyle = "#c7ccd1";
  ctx.beginPath();
  ctx.arc(headCenterX, midY, headRadius, 0, Math.PI * 2);
  ctx.fill();

  // A few short mesh strokes across the head so it reads as a mic capsule,
  // not a plain ball.
  ctx.strokeStyle = "#8b9096";
  ctx.lineWidth = 1;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(headCenterX - headRadius * 0.55, midY + i * headRadius * 0.4);
    ctx.lineTo(headCenterX + headRadius * 0.55, midY + i * headRadius * 0.4);
    ctx.stroke();
  }
}

function drawStick(ctx: CanvasRenderingContext2D, color: string): void {
  // A plain straight rod (walking stick / baton / selfie-stick shape) --
  // uniform thickness with a slightly bulbed cap at one end and a couple of
  // darker grip-wrap bands near the pivot end, drawn along the canvas's
  // long axis and angled at render time via STICK's own rotationDegrees.
  const h = ctx.canvas.height;
  const midY = h / 2;
  const barHeight = h * 0.26;
  const capRadius = h * 0.32;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(capRadius * 0.6, midY - barHeight / 2, ctx.canvas.width - capRadius * 0.6, barHeight, barHeight / 2);
  ctx.fill();
  // Cap knob.
  ctx.beginPath();
  ctx.arc(capRadius, midY, capRadius, 0, Math.PI * 2);
  ctx.fill();

  // Grip-wrap bands near the near (pivot) end.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  for (const x of [capRadius * 1.8, capRadius * 2.6, capRadius * 3.4]) {
    ctx.beginPath();
    ctx.moveTo(x, midY - barHeight / 2);
    ctx.lineTo(x, midY + barHeight / 2);
    ctx.stroke();
  }
}

function drawMoney(ctx: CanvasRenderingContext2D, color: string): void {
  // A small fanned stack of bills -- two back bills at a fixed, slightly
  // darker tone (depth cue, same "fixed secondary tint" posture as
  // drawKnife's blade) plus a front bill in `color`, each with a thin
  // border and a small oval "seal" so it reads as currency, not a plain
  // rectangle. Drawn flat (not along a long grip axis like the rod props
  // above) since a stack of bills is held presented, not gripped end-on.
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const billW = w * 0.72;
  const billH = h * 0.6;
  const stagger = w * 0.09;

  const drawBill = (offsetX: number, offsetY: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(offsetX, offsetY, billW, billH, 3);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(offsetX + 3, offsetY + 3, billW - 6, billH - 6);
  };

  drawBill(stagger * 2, h * 0.06, "#2f6b3a");
  drawBill(stagger, h * 0.16, "#3a7d44");
  drawBill(0, h * 0.26, color);

  // Seal on the front bill.
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(billW * 0.28, h * 0.26 + billH / 2, billH * 0.22, 0, Math.PI * 2);
  ctx.stroke();
}

function drawWallet(ctx: CanvasRenderingContext2D, color: string): void {
  // A bifold body in `color` with a center fold line and a card corner
  // peeking out of a slot (fixed light tint, suggesting a visible card) --
  // held flat/presented like drawMoney, not gripped end-on.
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 6);
  ctx.fill();

  // Fold line.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.1);
  ctx.lineTo(w * 0.5, h * 0.9);
  ctx.stroke();

  // Stitch-inset border.
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.strokeRect(4, 4, w - 8, h - 8);

  // A card corner peeking out of the near slot.
  ctx.fillStyle = "#e5e7eb";
  ctx.beginPath();
  ctx.roundRect(w * 0.08, -h * 0.12, w * 0.4, h * 0.3, 2);
  ctx.fill();
}

function drawCreditCard(ctx: CanvasRenderingContext2D, color: string): void {
  // A simple flat card in `color` with a fixed-tint gold chip and a couple
  // of number-line strokes -- held flat/presented, same posture as
  // drawMoney/drawWallet.
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 5);
  ctx.fill();

  // Chip.
  ctx.fillStyle = "#d4b25a";
  ctx.beginPath();
  ctx.roundRect(w * 0.1, h * 0.22, w * 0.2, h * 0.24, 2);
  ctx.fill();

  // Number-line strokes near the bottom.
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 2;
  for (const y of [h * 0.66, h * 0.8]) {
    ctx.beginPath();
    ctx.moveTo(w * 0.1, y);
    ctx.lineTo(w * 0.6, y);
    ctx.stroke();
  }
}

export const ACCESSORY_CATALOG: AccessoryCatalogEntry[] = [
  {
    accessoryAssetId: "sunglasses",
    name: "Sunglasses",
    anchorId: "head",
    // "head" anchor sits near the TOP of the skull (tuned for a hat, see
    // library.ts's own ANCHORS comment) -- sunglasses need to land lower, at
    // roughly eye level, hence a sizeable downward nudge here rather than
    // needing a second, eye-level anchor just for this one accessory.
    offsetFromAnchor: { x: 0, y: 54 },
    width: 90,
    height: 30,
    pivotX: 45,
    pivotY: 15,
    defaultColor: "#1a1a1a",
    draw: drawSunglasses,
  },
  {
    accessoryAssetId: "hat",
    name: "Hat",
    anchorId: "head",
    // No further nudge needed -- the "head" anchor is already positioned for
    // exactly this (see its own doc comment in library.ts).
    offsetFromAnchor: { x: 0, y: 0 },
    width: 110,
    height: 56,
    pivotX: 55,
    pivotY: 6,
    defaultColor: "#2b2b3d",
    draw: drawHat,
  },
  {
    accessoryAssetId: "pen",
    name: "Pen",
    // Held props ride "handR" (the biped-simple topology's right-hand
    // anchor, library.ts) rather than needing a new anchor of their own --
    // same "richer accessory, not a new topology" call the Phase 8 plan
    // makes for lightweight props like this.
    anchorId: "handR",
    alternateAnchorIds: ["handL"],
    // "handR" sits at the resting hand position; no further nudge needed,
    // the grip pivot (below) does the alignment work.
    offsetFromAnchor: { x: 0, y: 0 },
    width: 60,
    height: 14,
    // Pivot at roughly where fingers would grip the barrel, not the very
    // end -- keeps the tip/cap overhanging naturally past the hand.
    pivotX: 22,
    pivotY: 7,
    rotationDegrees: -35,
    defaultColor: "#2563eb",
    draw: drawPen,
  },
  {
    accessoryAssetId: "knife",
    name: "Knife",
    anchorId: "handR",
    alternateAnchorIds: ["handL"],
    offsetFromAnchor: { x: 0, y: 0 },
    width: 76,
    height: 22,
    // Pivot in the middle of the handle -- the blade extends away from the
    // grip, the short butt end barely overhangs the other side.
    pivotX: 12,
    pivotY: 11,
    rotationDegrees: -20,
    defaultColor: "#4b3220",
    draw: drawKnife,
  },
  {
    accessoryAssetId: "gun",
    name: "Gun",
    anchorId: "handR",
    alternateAnchorIds: ["handL"],
    offsetFromAnchor: { x: 0, y: 4 },
    width: 54,
    height: 34,
    // Pivot at the grip (bottom-left of the silhouette), matching where a
    // hand actually wraps around it.
    pivotX: 14,
    pivotY: 30,
    // Relaxed hold, barrel angled down -- a neutral "carrying," not
    // "aiming," default.
    rotationDegrees: 12,
    defaultColor: "#374151",
    draw: drawGun,
  },
  {
    accessoryAssetId: "microphone",
    name: "Microphone",
    anchorId: "handR",
    alternateAnchorIds: ["handL"],
    offsetFromAnchor: { x: 0, y: 0 },
    width: 58,
    height: 20,
    // Pivot on the handle, close to the capsule end -- a handheld mic is
    // usually gripped fairly high up, not at the very butt end.
    pivotX: 18,
    pivotY: 10,
    // Reuses FACEPALM's own proven ARM_R rotation (library.ts) rather than
    // re-deriving a new magic number -- same "raise the arm nearly all the
    // way up and in, toward the face" motion, just held for good (a mic is
    // naturally spoken into, not something set back down mid-take) instead
    // of one gesture beat. See AccessoryCatalogEntry.restPoseArmRotationRadians's
    // own doc comment for the mechanism, and compile.ts's compileAccessories
    // for the "handL" sign-mirroring.
    restPoseArmRotationRadians: 2.9,
    // Re-derived for the raised pose above, NOT the old resting-at-the-side
    // rotationDegrees=-40 this replaces: the arm bone itself now contributes
    // ~166 degrees (2.9 rad) of its own rotation, which this accessory's
    // rotationDegrees stacks additively onto (see that field's own doc
    // comment) -- so pointing the capsule roughly upright, mic head toward
    // the mouth, needs roughly the INVERSE of that plus a small tilt, not a
    // small tweak of the old value. Best-effort geometric estimate, not
    // confirmed against a live render (this sandbox has no browser canvas to
    // check against) -- nudge in the editor if the capsule doesn't read as
    // "held up to the mouth."
    rotationDegrees: 104,
    defaultColor: "#1f2937",
    draw: drawMicrophone,
  },
  {
    accessoryAssetId: "stick",
    name: "Stick",
    anchorId: "handR",
    alternateAnchorIds: ["handL"],
    offsetFromAnchor: { x: 0, y: 2 },
    width: 90,
    height: 16,
    // Pivot near the grip-wrap end, close to the cap -- the long bare end
    // extends away from the hand, matching drawKnife's "grip on one end,
    // rest of the shape overhangs" convention.
    pivotX: 14,
    pivotY: 8,
    rotationDegrees: -25,
    defaultColor: "#6b4a2b",
    draw: drawStick,
  },
  {
    accessoryAssetId: "money",
    name: "Money",
    anchorId: "handR",
    alternateAnchorIds: ["handL"],
    offsetFromAnchor: { x: 0, y: 0 },
    width: 50,
    height: 30,
    // Pivot near the stack's lower-near corner, where fingers would pinch
    // a fanned handful of bills.
    pivotX: 10,
    pivotY: 22,
    rotationDegrees: -12,
    defaultColor: "#4caf5c",
    draw: drawMoney,
  },
  {
    accessoryAssetId: "wallet",
    name: "Wallet",
    anchorId: "handR",
    alternateAnchorIds: ["handL"],
    offsetFromAnchor: { x: 0, y: 2 },
    width: 42,
    height: 30,
    pivotX: 10,
    pivotY: 22,
    rotationDegrees: -10,
    defaultColor: "#3b2a1f",
    draw: drawWallet,
  },
  {
    accessoryAssetId: "creditCard",
    name: "Credit card",
    anchorId: "handR",
    alternateAnchorIds: ["handL"],
    offsetFromAnchor: { x: 0, y: 0 },
    width: 44,
    height: 28,
    pivotX: 8,
    pivotY: 20,
    rotationDegrees: -15,
    defaultColor: "#1d4ed8",
    draw: drawCreditCard,
  },
];

export function getAccessoryCatalogEntry(accessoryAssetId: string): AccessoryCatalogEntry | null {
  return ACCESSORY_CATALOG.find((entry) => entry.accessoryAssetId === accessoryAssetId) ?? null;
}

// Keyed by `${accessoryAssetId}:${color}` -- an accessory drawn with the same
// color override (or none, i.e. its own defaultColor) never needs a second
// canvas draw/decode round trip.
const decodedImageCache = new Map<string, Promise<HTMLImageElement>>();

/** Renders `entry` (tinted `colorOverride`, or its own defaultColor) into a
 * small offscreen canvas and returns it as a decoded, drawable image --
 * promise-cached exactly like compile.ts's own loadAtlasImage, for the same
 * reason (two callers requesting the identical accessory+color before the
 * first decode finishes share one decode rather than duplicating it). */
export function loadAccessoryImage(entry: AccessoryCatalogEntry, colorOverride?: string): Promise<HTMLImageElement> {
  const color = colorOverride ?? entry.defaultColor;
  const key = `${entry.accessoryAssetId}:${color}`;
  const cached = decodedImageCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = entry.width;
    canvas.height = entry.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(`loadAccessoryImage: 2D context unavailable for "${entry.accessoryAssetId}"`);
    entry.draw(ctx, color);

    const image = new Image();
    image.src = canvas.toDataURL("image/png");
    await image.decode();
    return image;
  })();

  promise.catch(() => {
    if (decodedImageCache.get(key) === promise) decodedImageCache.delete(key);
  });
  decodedImageCache.set(key, promise);
  return promise;
}
