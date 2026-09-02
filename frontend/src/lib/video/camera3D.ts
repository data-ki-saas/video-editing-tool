/**
 * "Make it 3D" -- real dolly + tilt + roll camera motion for a Ken Burns
 * image cutaway or an image/video overlay, rendered via three.js. A drop-in
 * sibling to drawImageFlipped/drawImageFlippedMasked (video.ts): same
 * signature shape, called from the same two places (CanvasPlayer.tsx's live
 * preview and localRender/exportTimeline.ts's frame-accurate export), so
 * both draw identical pixels with no drift between preview and final
 * render -- there is no separate "server-side" reproduction of this effect
 * (see this feature's own plan doc on why Creatomate's JSON compiler is
 * deliberately NOT touched: cloud render is disabled/paid-tier, the free
 * local pipeline is the one that matters).
 *
 * The "dolly" is never authored here directly -- it rides whichever
 * pan/zoom motion (a ZoomEffect, or an overlay's own start->end window) the
 * caller is already animating; this module only adds the tilt/roll/push
 * that makes that existing motion read as a real camera move instead of a
 * flat crop-rect slide. One fixed "cinematic" amplitude, no exposed knobs,
 * per this app's driving vision (smart defaults over pro-NLE controls).
 */
import * as THREE from "three";
import { drawImageFlipped } from "./video";
import { easeInOut, type ZoomEffect } from "./video_math";

export interface Camera3DPose {
  xRotationDegrees: number; // tilt
  zRotationDegrees: number; // roll
  perspective: number; // smaller = stronger 3D depth (see fovForPerspective below)
  extraScale: number; // subtle push-in multiplier, layered on the caller's own dest rect
}

// Amplitude constants -- visibly "cinematic" without being disorienting:
// verified against a real live preview that anything much subtler (an
// earlier pass tried 6deg/4deg/1.08x) reads as barely-there at normal
// viewing size, while these values clearly foreshorten/shift the frame
// without the plane's edges pulling in far enough to reveal much of
// whatever's behind it (see Camera3DRenderer's own comment on why that
// reveal is still a graceful fallback, not a bug, when it does happen at
// the extremes).
const MAX_TILT_DEGREES = 16;
const MAX_ROLL_DEGREES = 10;
const MAX_PUSH_SCALE = 1.15;
// perspective=1 is "resting" (weakest depth); perspective=0 is the peak
// (strongest). Kept 0..1 rather than mirroring Creatomate's raw-distance
// convention, since this module never talks to Creatomate -- see this
// file's own module comment.
const BASE_FOV_DEGREES = 25;
const PEAK_FOV_DEGREES = 50;
const CAMERA_DISTANCE = 10;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function poseAtProgress(t: number, tiltSign: number, rollSign: number): Camera3DPose {
  const eased = easeInOut(t);
  return {
    xRotationDegrees: tiltSign * MAX_TILT_DEGREES * eased,
    zRotationDegrees: rollSign * MAX_ROLL_DEGREES * eased,
    perspective: 1 - eased,
    extraScale: lerp(1, MAX_PUSH_SCALE, eased),
  };
}

/** Tilt/roll direction derived from which Ken Burns axes are active on the
 * paired effect -- same "any subset of axes combines" spirit as
 * imageTemplates.ts's kenBurnsRects, but only the SIGN matters here (the
 * amplitude is the fixed constants above -- this app deliberately doesn't
 * expose a per-clip intensity knob). Falls back to a fixed push+tilt+roll
 * when no recognized axis is present (mirrors buildKenBurnsEffect's own
 * "falls back to zoom-in" default). */
function directionFromTemplateIds(templateIds: string[]): { tiltSign: number; rollSign: number } {
  const ids = new Set(templateIds);
  let tiltSign = 0;
  let rollSign = 0;
  if (ids.has("zoom-in")) tiltSign += 1;
  if (ids.has("zoom-out") && !ids.has("zoom-in")) tiltSign -= 1;
  if (ids.has("pan-up")) tiltSign -= 1;
  if (ids.has("pan-down") && !ids.has("pan-up")) tiltSign += 1;
  if (ids.has("pan-left")) rollSign -= 1;
  if (ids.has("pan-right") && !ids.has("pan-left")) rollSign += 1;
  return { tiltSign: tiltSign === 0 ? 1 : Math.sign(tiltSign), rollSign };
}

/** The pose at `timeSeconds` for a Ken Burns image cutaway's paired
 * ZoomEffect -- rides the SAME two-half start->epicenter->end timing
 * computeEffectiveCropRect already uses (video_math.ts), easing the tilt/
 * roll/push INTO the epicenter and back OUT of it, rather than a separate
 * timeline of its own. Returns the neutral (no-op) pose when `timeSeconds`
 * is outside the effect's own range -- callers should only invoke this
 * while the effect is active (same precondition computeEffectiveCropRect's
 * own callers already satisfy via findActiveZoomEffectIndex). */
export function computeCamera3DPoseForZoomEffect(zoomEffect: ZoomEffect, templateIds: string[], timeSeconds: number): Camera3DPose {
  const { tiltSign, rollSign } = directionFromTemplateIds(templateIds);
  if (timeSeconds <= zoomEffect.epicenterTimeSeconds) {
    const duration = zoomEffect.epicenterTimeSeconds - zoomEffect.startTimeSeconds;
    const t = duration > 0 ? (timeSeconds - zoomEffect.startTimeSeconds) / duration : 1;
    return poseAtProgress(Math.min(Math.max(t, 0), 1), tiltSign, rollSign);
  }
  const duration = zoomEffect.endTimeSeconds - zoomEffect.epicenterTimeSeconds;
  const t = duration > 0 ? (timeSeconds - zoomEffect.epicenterTimeSeconds) / duration : 1;
  return poseAtProgress(1 - Math.min(Math.max(t, 0), 1), tiltSign, rollSign);
}

/** The pose for an image/video overlay -- overlays have only a static
 * `OverlayFraming` (no keyframed pan/zoom timeline to ride), so the dolly is
 * synthesized as one fixed, one-directional ease across the overlay's own
 * start->end window, same one-directional shape buildKenBurnsEffect uses
 * for a plain (non-back-and-forth) Ken Burns move. No directional template
 * to derive a sign from, so a fixed gentle push+tilt-down+roll-right is
 * used throughout -- reads as "cinematic" regardless of the overlay's own
 * content. */
export function computeCamera3DPoseForOverlay(startTimeSeconds: number, endTimeSeconds: number, timeSeconds: number): Camera3DPose {
  const duration = endTimeSeconds - startTimeSeconds;
  const t = duration > 0 ? (timeSeconds - startTimeSeconds) / duration : 1;
  return poseAtProgress(Math.min(Math.max(t, 0), 1), 1, 1);
}

function fovForPerspective(perspective: number): number {
  return lerp(BASE_FOV_DEGREES, PEAK_FOV_DEGREES, 1 - Math.min(Math.max(perspective, 0), 1));
}

/**
 * One reusable three.js render target: a WebGLRenderer on an offscreen
 * canvas, one PerspectiveCamera, one textured plane. Reused SEQUENTIALLY
 * across every 3D-enabled element a single frame needs (base clip, then any
 * 3D-enabled overlay on top) -- never one WebGL context per element, since
 * browsers cap how many can be live at once and spinning one up per call
 * would also be needlessly slow across an export's full frame loop. Callers
 * own the instance's lifetime (create once, `dispose()` once) -- see
 * CanvasPlayer.tsx (one per mount) and exportTimeline.ts (one per export
 * run).
 *
 * The plane is sized every draw call so it exactly fills the destination
 * rect AT REST (pose.xRotationDegrees/zRotationDegrees both 0,
 * extraScale 1) -- rotating it away from rest is what reveals a sliver of
 * transparent background at the plane's foreshortened edge; the renderer's
 * own background is left transparent (alpha:true, clear color alpha 0) so
 * that sliver shows whatever the caller already painted on `ctx` beneath
 * this element, same draw-order dependency the existing backdrop-then-clip
 * call sites already rely on -- not a bug, reads as the photo genuinely
 * floating in front of its backdrop.
 *
 * `antialias: false` -- this renders continuously (a live preview loop, or
 * one call per exported frame), and MSAA on a single quad buys little
 * visual benefit while measurably slowing down software-rendered WebGL
 * (verified against a real browser session using SwiftShader, where
 * leaving it on made the live preview loop struggle to keep up).
 */
export class Camera3DRenderer {
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private scene: THREE.Scene;
  private mesh: THREE.Mesh;
  private texture: THREE.CanvasTexture;
  private scratchCanvas: HTMLCanvasElement;
  private scratchCtx: CanvasRenderingContext2D;

  constructor() {
    const canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "low-power" });
    this.renderer.setClearColor(0x000000, 0);

    this.camera = new THREE.PerspectiveCamera(BASE_FOV_DEGREES, 1, 0.1, CAMERA_DISTANCE * 4);
    this.camera.position.set(0, 0, CAMERA_DISTANCE);

    this.scratchCanvas = document.createElement("canvas");
    const scratchCtx = this.scratchCanvas.getContext("2d");
    if (!scratchCtx) throw new Error("Camera3DRenderer: 2D context unavailable for scratch canvas");
    this.scratchCtx = scratchCtx;

    this.texture = new THREE.CanvasTexture(this.scratchCanvas);
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);

    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
  }

  dispose(): void {
    this.renderer.dispose();
    this.texture.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  /** Renders `source`'s [sx,sy,sWidth,sHeight] sub-rect through the 3D
   * scene at `pose`, then composites the result into `ctx` at
   * [destX,destY,destWidth,destHeight] -- same argument shape as
   * drawImageFlipped, so call sites swap one function for the other rather
   * than restructuring their draw loop. */
  drawImage3D(
    ctx: CanvasRenderingContext2D,
    source: CanvasImageSource,
    pose: Camera3DPose,
    sx: number,
    sy: number,
    sWidth: number,
    sHeight: number,
    destX: number,
    destY: number,
    destWidth: number,
    destHeight: number,
    flipHorizontal: boolean,
    flipVertical: boolean
  ): void {
    if (destWidth <= 0 || destHeight <= 0) return;

    if (this.scratchCanvas.width !== sWidth || this.scratchCanvas.height !== sHeight) {
      this.scratchCanvas.width = sWidth;
      this.scratchCanvas.height = sHeight;
    }
    this.scratchCtx.clearRect(0, 0, sWidth, sHeight);
    drawImageFlipped(this.scratchCtx, source, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight, flipHorizontal, flipVertical);
    this.texture.needsUpdate = true;

    const canvas = this.renderer.domElement;
    if (canvas.width !== destWidth || canvas.height !== destHeight) {
      this.renderer.setSize(destWidth, destHeight, false);
    }

    const fovDegrees = fovForPerspective(pose.perspective);
    this.camera.fov = fovDegrees;
    this.camera.aspect = destWidth / destHeight;
    this.camera.updateProjectionMatrix();

    const fovRad = THREE.MathUtils.degToRad(fovDegrees);
    const visibleHeight = 2 * CAMERA_DISTANCE * Math.tan(fovRad / 2);
    const visibleWidth = visibleHeight * (destWidth / destHeight);
    this.mesh.scale.set(visibleWidth * pose.extraScale, visibleHeight * pose.extraScale, 1);
    this.mesh.rotation.x = THREE.MathUtils.degToRad(pose.xRotationDegrees);
    this.mesh.rotation.z = THREE.MathUtils.degToRad(pose.zRotationDegrees);

    this.renderer.render(this.scene, this.camera);
    ctx.drawImage(canvas, destX, destY, destWidth, destHeight);
  }
}
