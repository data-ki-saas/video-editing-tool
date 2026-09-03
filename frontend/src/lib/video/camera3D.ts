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
 * caller is already animating; this module only adds the camera push/pan
 * that makes that existing motion read as a real camera move instead of a
 * flat crop-rect slide. One fixed "cinematic" amplitude, no exposed knobs,
 * per this app's driving vision (smart defaults over pro-NLE controls).
 *
 * The camera actually MOVES (translates toward/across a static, unrotated
 * plane, always re-aimed at the plane's center via lookAt) rather than the
 * plane rotating in front of a fixed camera -- same technique as
 * `test/test.html`'s reference walkthrough. An earlier version rotated the
 * plane on two axes while sweeping the FOV wide to sell the depth; that
 * combination pushes the plane's trailing edge toward a grazing viewing
 * angle, and grazing angles minify a texture far more in one direction than
 * the other, which no mipmap level represents well -- it reads as a blurred
 * edge (worst for overlays, whose fixed "roll-right" direction always
 * foreshortens the RIGHT edge). Moving the camera with a constant, moderate
 * FOV keeps the plane close to face-on throughout, so there's no grazing
 * angle to blur.
 */
import * as THREE from "three";
import { drawImageFlipped } from "./video";
import { easeInOut, type ZoomEffect } from "./video_math";

export interface Camera3DPose {
  panXFraction: number; // horizontal camera dolly-pan, as a fraction of the frame's rest half-width
  panYFraction: number; // vertical camera dolly-pan, as a fraction of the frame's rest half-height
  pushFraction: number; // 0..1, how far the camera has dollied in toward the plane (0 = resting, 1 = peak)
}

// Amplitude constants -- visibly "cinematic" without being disorienting.
// pushFraction is a DISTANCE ratio, not a size ratio: apparent magnification
// is roughly 1/(1-pushFraction), so an earlier pass at 0.45/0.22/0.14 (which
// only re-derived a plausible-looking magnitude from test/test.html's own
// example values, not from this app's actual tuned feel) was an ~1.8x
// zoom-in-then-back-out -- dramatic enough that several cutaways in a row
// each snapping back to their exact starting frame read as the same photo
// "repeating". These values keep the SAME ratio between push and pan (the
// ratio, not the absolute size, is what keeps the plane covering the frame
// -- see Camera3DRenderer's own comment) scaled down to roughly match the
// original rotate-the-plane version's subtler ~1.15x-equivalent intensity,
// verified against a real live preview.
const MAX_PAN_X_FRACTION = 0.06;
const MAX_PAN_Y_FRACTION = 0.04;
const MAX_PUSH_FRACTION = 0.13;
// A plain (never-manually-epicentered) Ken Burns clip has its ZoomEffect's
// epicenterTimeSeconds === endTimeSeconds (buildKenBurnsEffect always seeds
// it that way -- most cutaways never touch ZoomEffectsTrack's epicenter
// drag at all), which collapses computeCamera3DPoseForZoomEffect's "ease
// back OUT of the epicenter" half to zero duration: the 3D pose then keeps
// easing further INTO its push/tilt/pan every frame right up to the clip's
// own last one, never settling back to neutral before the cut. Followed by
// a flat (non-3D) clip that reads fine -- the photo just changes -- but
// followed by ANOTHER "Make it 3D" clip, which starts its own dolly ramping
// up again from neutral with no settle in between, the two reads as one
// continuous camera move carrying straight across the cut rather than two
// independent shots (reported as "the 3D effect keeps playing over the next
// cutaway"). Reserving at least this fraction of the clip's own duration as
// a 3D-only ease-out window -- independent of the ACTUAL authored
// epicenterTimeSeconds, which keeps driving the 2D crop rect unchanged --
// guarantees a real settle-back-to-neutral beat before every cut, even for
// this (common) default-epicenter case, while leaving an already-dragged
// epicenter (already < endTimeSeconds by more than this) untouched.
const MIN_EASE_OUT_FRACTION = 0.25;
// Constant throughout the move (mirrors test/test.html) -- a moderate,
// fixed FOV rather than a wide sweep is what keeps the plane close to
// face-on to the camera, avoiding the grazing-angle blur described above.
const FOV_DEGREES = 45;
const CAMERA_DISTANCE = 10;

function poseAtProgress(t: number, tiltSign: number, rollSign: number): Camera3DPose {
  const eased = easeInOut(t);
  return {
    panXFraction: rollSign * MAX_PAN_X_FRACTION * eased,
    panYFraction: -tiltSign * MAX_PAN_Y_FRACTION * eased,
    pushFraction: MAX_PUSH_FRACTION * eased,
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
 * own callers already satisfy via findActiveZoomEffectIndex).
 *
 * The 3D pose's own epicenter is clamped to leave at least
 * MIN_EASE_OUT_FRACTION of the clip for the ease-OUT half, even when the
 * REAL authored epicenterTimeSeconds sits right at (or very close to)
 * endTimeSeconds -- see that constant's own comment for why, otherwise, the
 * 3D dolly never settles back to neutral before the cut. The 2D crop rect
 * this rides is untouched (still reads the real epicenterTimeSeconds via
 * computeEffectiveCropRect directly) -- only this superimposed camera
 * push/pan/tilt gets the synthetic ease-out window. */
export function computeCamera3DPoseForZoomEffect(zoomEffect: ZoomEffect, templateIds: string[], timeSeconds: number): Camera3DPose {
  const { tiltSign, rollSign } = directionFromTemplateIds(templateIds);
  const clipDuration = zoomEffect.endTimeSeconds - zoomEffect.startTimeSeconds;
  const poseEpicenterTimeSeconds = Math.min(zoomEffect.epicenterTimeSeconds, zoomEffect.endTimeSeconds - MIN_EASE_OUT_FRACTION * clipDuration);
  if (timeSeconds <= poseEpicenterTimeSeconds) {
    const duration = poseEpicenterTimeSeconds - zoomEffect.startTimeSeconds;
    const t = duration > 0 ? (timeSeconds - zoomEffect.startTimeSeconds) / duration : 1;
    return poseAtProgress(Math.min(Math.max(t, 0), 1), tiltSign, rollSign);
  }
  const duration = zoomEffect.endTimeSeconds - poseEpicenterTimeSeconds;
  const t = duration > 0 ? (timeSeconds - poseEpicenterTimeSeconds) / duration : 1;
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
 * rect AT REST (camera at (0,0,CAMERA_DISTANCE), FOV_DEGREES, looking
 * straight down -Z) -- panning the CAMERA away from rest is what can reveal
 * a sliver of transparent background at the plane's edge; the renderer's
 * own background is left transparent (alpha:true, clear color alpha 0) so
 * that sliver shows whatever the caller already painted on `ctx` beneath
 * this element, same draw-order dependency the existing backdrop-then-clip
 * call sites already rely on -- not a bug, reads as the photo genuinely
 * floating in front of its backdrop. In practice the simultaneous push-in
 * (the camera also moves closer, magnifying the plane) keeps this from
 * happening across the amplitude range tuned above.
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

    this.camera = new THREE.PerspectiveCamera(FOV_DEGREES, 1, 0.1, CAMERA_DISTANCE * 4);
    this.camera.position.set(0, 0, CAMERA_DISTANCE);

    this.scratchCanvas = document.createElement("canvas");
    const scratchCtx = this.scratchCanvas.getContext("2d");
    if (!scratchCtx) throw new Error("Camera3DRenderer: 2D context unavailable for scratch canvas");
    this.scratchCtx = scratchCtx;

    this.texture = new THREE.CanvasTexture(this.scratchCanvas);
    // Anisotropic filtering: even face-on, the push-in dolly minifies the
    // texture more along one screen-space direction than the other once the
    // camera has panned off-center -- without this, mip selection alone
    // blurs that direction. Cheap, and the standard fix for any obliquely
    // viewed texture.
    this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.position.set(0, 0, 0);

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

    this.camera.fov = FOV_DEGREES;
    this.camera.aspect = destWidth / destHeight;
    this.camera.updateProjectionMatrix();

    // Plane stays flat and unrotated, sized to exactly fill the frame at
    // the camera's REST position/FOV -- only the camera moves (translates
    // toward and across the plane, always re-aimed via lookAt), same
    // technique as test/test.html. See this class's own doc comment for why
    // that avoids the grazing-angle blur a rotating plane produced.
    const fovRad = THREE.MathUtils.degToRad(FOV_DEGREES);
    const visibleHeight = 2 * CAMERA_DISTANCE * Math.tan(fovRad / 2);
    const visibleWidth = visibleHeight * (destWidth / destHeight);
    this.mesh.scale.set(visibleWidth, visibleHeight, 1);

    const dollyDistance = CAMERA_DISTANCE * (1 - pose.pushFraction);
    this.camera.position.set(pose.panXFraction * (visibleWidth / 2), pose.panYFraction * (visibleHeight / 2), dollyDistance);
    this.camera.lookAt(0, 0, 0);

    this.renderer.render(this.scene, this.camera);
    ctx.drawImage(canvas, destX, destY, destWidth, destHeight);
  }
}
