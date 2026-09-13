/**
 * Draws one posed CompiledAvatar frame into a plain 2D `ctx` -- the last
 * step of the Avatar animation engine's pipeline (compile.ts builds a
 * CompiledAvatar once; actions.ts turns (actionId, elapsedSeconds, seed)
 * into a pose every frame; this file turns that pose into pixels).
 *
 * Unlike camera3D.ts's Camera3DRenderer, this is plain exported functions
 * rather than a class -- deliberately. Camera3DRenderer needs a class
 * because it owns real disposable GPU resources (a WebGLRenderer, textures,
 * geometries) with an actual lifecycle a caller must construct once and
 * dispose once. This module owns nothing persistent: Canvas2D has no
 * comparable per-instance resource to allocate up front, so there is
 * nothing a class would give this file beyond ceremony -- a plain function
 * called fresh every frame is simpler and exactly sufficient.
 */
import type { CompiledAvatar } from "./compile";
import type { BoneTransform } from "./topology";

/** Draws `compiled`, posed as `pose`, into `destRect` of `ctx` -- `pose` is
 * expected to be `actions.ts`'s `computeAvatarPose` output for whichever
 * action/time this frame represents, and `mouthShapeId` its
 * `computeMouthShapeId` output for the same instant; both are plain
 * parameters here rather than computed inside this function so this stays a
 * pure draw step with no action-evaluation concerns of its own.
 *
 * Algorithm:
 *  1. Fit-by-height: the rig's `rigHeight` is scaled to exactly fill
 *     `destRect`'s height, centered horizontally within its width (so a
 *     destRect proportionally wider than the rig leaves slack on the sides
 *     -- expected/fine for a bust-framed portrait character dropped into a
 *     wider box, not a bug).
 *  2. Forward kinematics, bone 0 (root) through boneCount-1, building each
 *     bone's WORLD matrix from its PARENT's already-built world matrix
 *     (bone 0 builds from a root matrix derived straight from the fit
 *     above). This is only a valid single linear pass because
 *     compile.ts's own validation already guarantees `parentIndex[i] < i`
 *     for every bone -- a parent's world matrix always exists by the time a
 *     child needs it.
 *  3. Draw every part (already zOrder-sorted at compile time) by
 *     transforming into its own bone's world matrix and drawing its atlas
 *     rect offset by its own pivot -- substituting the active mouth shape's
 *     rect/pivot in place of the mouth slot's own, when this part IS that
 *     slot.
 */
export function drawAvatar(
  ctx: CanvasRenderingContext2D,
  compiled: CompiledAvatar,
  pose: BoneTransform[],
  destRect: { x: number; y: number; width: number; height: number },
  mouthShapeId: string
): void {
  if (destRect.width <= 0 || destRect.height <= 0) return;

  const { topology, skin } = compiled;

  const scale = destRect.height / topology.rigHeight;
  const scaledRigWidth = topology.rigWidth * scale;
  const originX = destRect.x + (destRect.width - scaledRigWidth) / 2;
  const originY = destRect.y;

  // Outer save/restore is a safety net so this never leaks a transform (or
  // any other ctx state this function might come to touch) into whatever
  // the caller draws next -- every per-part draw below balances its own
  // save/restore in addition to this, since ctx.transform COMPOSES rather
  // than replaces (see the per-part loop's own comment).
  ctx.save();

  const rootMatrix = new DOMMatrix([scale, 0, 0, scale, originX, originY]);

  const worldMatrices: DOMMatrix[] = new Array(topology.boneCount);
  for (let boneIndex = 0; boneIndex < topology.boneCount; boneIndex++) {
    const local = pose[boneIndex];
    const parentMatrix = boneIndex === 0 ? rootMatrix : worldMatrices[topology.parentIndex[boneIndex]];
    // DOMMatrix.rotate takes DEGREES -- every bone's own rotation is stored
    // in radians (topology.ts's own convention), so this conversion is
    // required every bone, every frame; skipping it would rotate by ~57x
    // too much. DOMMatrix methods return NEW matrices rather than mutating
    // the receiver, which is exactly what's wanted here: each bone's matrix
    // is independent, built from its parent's without disturbing it (so a
    // later sibling bone can build from the same parent matrix unaffected).
    worldMatrices[boneIndex] = parentMatrix.translate(local.x, local.y).rotate((local.rotation * 180) / Math.PI).scale(local.scaleX, local.scaleY);
  }

  for (const part of skin.parts) {
    // A mouth shape swaps in for whichever `parts` entry is its own slot --
    // recognized here by partId equality against the active mouthShapeId's
    // resolved entry (compile.ts builds every mouthShapes[] entry sharing
    // that same partId with its slot's own `parts` entry -- see
    // CompiledSkin.mouthShapes's own doc comment). Every other part is
    // unaffected by mouthShapeId entirely.
    const activeMouthShape = skin.mouthShapes[mouthShapeId];
    const isMouthSlot = activeMouthShape !== undefined && activeMouthShape.partId === part.partId;
    const atlasRect = isMouthSlot ? activeMouthShape.atlasRect : part.atlasRect;
    const pivotX = isMouthSlot ? activeMouthShape.pivotX : part.pivotX;
    const pivotY = isMouthSlot ? activeMouthShape.pivotY : part.pivotY;

    const m = worldMatrices[part.boneIndex];
    ctx.save();
    // ctx.transform COMPOSES onto whatever transform ctx already has,
    // unlike ctx.setTransform which would REPLACE it -- required here since
    // this function must not clobber any transform the caller already has
    // active (e.g. mid-frame compositing done by whatever placed this
    // avatar on the canvas in the first place).
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(
      skin.atlasImage,
      atlasRect.sx,
      atlasRect.sy,
      atlasRect.sWidth,
      atlasRect.sHeight,
      -pivotX,
      -pivotY,
      atlasRect.sWidth,
      atlasRect.sHeight
    );
    ctx.restore();
  }

  ctx.restore();
}
