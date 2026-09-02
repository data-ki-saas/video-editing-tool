/**
 * A small library of subtle, purely time-driven ambient overlay effects --
 * "Light Sweep", "Sparkle", "Leaves" -- that composite on top of whatever a
 * clip already drew. Deliberately pipeline-agnostic: both the plain 2D Ken
 * Burns path and the "Make it 3D" path (camera3D.ts) converge on the same
 * 2D `ctx` before this runs, so one effect library works identically either
 * way -- no separate 3D-specific implementation needed, no three.js here.
 *
 * Same drop-in shape as camera3D.ts/video.ts's draw functions: called from
 * CanvasPlayer.tsx's live preview and exportTimeline.ts's frame-accurate
 * export with the same dest rect + elapsed time, so preview and export
 * never drift. Every effect is a PURE function of (destRect,
 * elapsedSeconds, seed) -- no Math.random(), no wall-clock reads -- so it
 * reproduces byte-identical frames in both the rAF preview loop and the
 * seeked export loop. `elapsedSeconds` is time since the OWNING clip/
 * overlay started (not timeline time), so an effect's own loop is
 * self-contained regardless of where the clip sits on the timeline -- same
 * relative-timing convention camera3D.ts's poses already use. One fixed
 * "cinematic" amplitude per effect, no exposed knobs, same philosophy as
 * camera3D.ts.
 */

export type AmbientEffectId = "light-sweep" | "sparkle" | "leaves";

export interface AmbientEffectOption {
  id: AmbientEffectId;
  label: string;
  description: string;
}

export const AMBIENT_EFFECT_OPTIONS: AmbientEffectOption[] = [
  { id: "light-sweep", label: "Light Sweep", description: "A soft glow drifts diagonally across the frame, like shifting sunlight." },
  { id: "sparkle", label: "Sparkle", description: "Faint light flecks twinkle and drift across the frame." },
  { id: "leaves", label: "Leaves", description: "A few leaves drift gently across the frame." },
];

/** Deterministic per-clip seed (0..1) derived from whatever stable
 * identifier the caller already has (a SequenceEntry's `id`, or an
 * overlay's own startTimeSeconds) -- so multiple simultaneous instances of
 * the same effect don't move in lockstep. Not cryptographic, just
 * decorrelation between clips. */
export function ambientEffectSeed(input: string | number): number {
  const str = String(input);
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

/** mulberry32 -- a tiny, fast, deterministic PRNG seeded from a 0..1 float,
 * used only to lay out each effect's fixed particle field once per draw
 * call (never to drive motion directly -- motion is a pure function of
 * elapsedSeconds so it's identical across repeated calls at the same time). */
function mulberry32(seed01: number): () => number {
  let a = Math.floor(seed01 * 0xffffffff) >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawLightSweep(
  ctx: CanvasRenderingContext2D,
  destX: number,
  destY: number,
  destWidth: number,
  destHeight: number,
  elapsedSeconds: number,
  seed: number
): void {
  const PERIOD_SECONDS = 10;
  const t = (((elapsedSeconds + seed * PERIOD_SECONDS) % PERIOD_SECONDS) + PERIOD_SECONDS) % PERIOD_SECONDS / PERIOD_SECONDS;

  const diagonal = Math.hypot(destWidth, destHeight);
  const travel = diagonal * 1.6; // starts and ends fully off-frame, no hard cut at the loop point
  const bandHalfWidth = diagonal * 0.22;
  const centerOffset = -travel / 2 + t * travel;
  const angle = Math.PI / 5; // ~36deg diagonal, matches the "sweeping diagonally" ask
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const cx = destX + destWidth / 2 + dx * centerOffset;
  const cy = destY + destHeight / 2 + dy * centerOffset;

  ctx.save();
  ctx.beginPath();
  ctx.rect(destX, destY, destWidth, destHeight);
  ctx.clip();
  // "screen" so the sweep reads as light ADDING onto the photo rather than
  // a flat white shape painted over it.
  ctx.globalCompositeOperation = "screen";
  const gradient = ctx.createLinearGradient(cx - dx * bandHalfWidth, cy - dy * bandHalfWidth, cx + dx * bandHalfWidth, cy + dy * bandHalfWidth);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.5, "rgba(255,250,235,0.16)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(destX, destY, destWidth, destHeight);
  ctx.restore();
}

const SPARKLE_COUNT = 14;

function drawSparkle(
  ctx: CanvasRenderingContext2D,
  destX: number,
  destY: number,
  destWidth: number,
  destHeight: number,
  elapsedSeconds: number,
  seed: number
): void {
  const random = mulberry32(seed);
  ctx.save();
  ctx.beginPath();
  ctx.rect(destX, destY, destWidth, destHeight);
  ctx.clip();
  ctx.globalCompositeOperation = "screen";

  for (let i = 0; i < SPARKLE_COUNT; i++) {
    const baseX = random();
    const baseY = random();
    const twinklePeriod = 2.5 + random() * 2.5;
    const twinklePhase = random() * twinklePeriod;
    const driftAngle = random() * Math.PI * 2;
    const driftSpeed = 0.012 + random() * 0.015; // fraction of frame per second
    const radiusFraction = 0.006 + random() * 0.01;

    const twinkleT = (elapsedSeconds + twinklePhase) % twinklePeriod;
    const pulse = Math.sin((twinkleT / twinklePeriod) * Math.PI); // one soft pulse per period
    const opacity = Math.max(0, pulse) * 0.55;
    if (opacity <= 0.01) continue;

    const driftDistance = elapsedSeconds * driftSpeed;
    const fracX = (((baseX + Math.cos(driftAngle) * driftDistance) % 1) + 1) % 1;
    const fracY = (((baseY + Math.sin(driftAngle) * driftDistance) % 1) + 1) % 1;
    const x = destX + fracX * destWidth;
    const y = destY + fracY * destHeight;
    const radius = radiusFraction * Math.min(destWidth, destHeight);

    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(255,255,255,${opacity})`);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const LEAF_COUNT = 5;
const LEAF_COLORS = ["#8a9a4b", "#b5793a"]; // muted green / autumn brown

function drawLeaves(
  ctx: CanvasRenderingContext2D,
  destX: number,
  destY: number,
  destWidth: number,
  destHeight: number,
  elapsedSeconds: number,
  seed: number
): void {
  const random = mulberry32(seed);
  ctx.save();
  ctx.beginPath();
  ctx.rect(destX, destY, destWidth, destHeight);
  ctx.clip();

  for (let i = 0; i < LEAF_COUNT; i++) {
    const crossingPeriod = 9 + random() * 5; // seconds to cross the whole frame
    const phase = random() * crossingPeriod;
    const lane = random(); // roughly constant vertical fraction
    const swayAmplitude = (0.04 + random() * 0.03) * destHeight;
    const swayPeriod = 2.5 + random() * 1.5;
    const swayPhase = random() * Math.PI * 2;
    const size = (0.03 + random() * 0.02) * Math.min(destWidth, destHeight);
    const spinSpeed = (random() - 0.5) * 1.2; // rad/s
    const color = LEAF_COLORS[random() < 0.5 ? 0 : 1];

    const crossingT = ((elapsedSeconds + phase) % crossingPeriod) / crossingPeriod; // 0..1
    const fadeEdge = 0.08;
    const opacity = Math.min(1, Math.min(crossingT, 1 - crossingT) / fadeEdge) * 0.65;
    if (opacity <= 0.02) continue;

    const x = destX - size + crossingT * (destWidth + size * 2);
    const y = destY + lane * destHeight + Math.sin((elapsedSeconds / swayPeriod) * Math.PI * 2 + swayPhase) * swayAmplitude;
    const rotation = elapsedSeconds * spinSpeed;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 0, size, size * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = Math.max(1, size * 0.06);
    ctx.beginPath();
    ctx.moveTo(-size, 0);
    ctx.lineTo(size, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/** Draws `effectId` (a no-op when absent) on top of whatever `ctx` already
 * has painted at [destX,destY,destWidth,destHeight] -- call this AFTER the
 * clip's own draw (plain 2D Ken Burns or camera3D.ts's drawImage3D), same
 * "layered on top of the existing motion" relationship camera3D.ts has to
 * a ZoomEffect. */
export function drawAmbientEffect(
  ctx: CanvasRenderingContext2D,
  effectId: AmbientEffectId | null | undefined,
  destX: number,
  destY: number,
  destWidth: number,
  destHeight: number,
  elapsedSeconds: number,
  seed: number
): void {
  if (!effectId || destWidth <= 0 || destHeight <= 0) return;
  switch (effectId) {
    case "light-sweep":
      drawLightSweep(ctx, destX, destY, destWidth, destHeight, elapsedSeconds, seed);
      return;
    case "sparkle":
      drawSparkle(ctx, destX, destY, destWidth, destHeight, elapsedSeconds, seed);
      return;
    case "leaves":
      drawLeaves(ctx, destX, destY, destWidth, destHeight, elapsedSeconds, seed);
      return;
  }
}
