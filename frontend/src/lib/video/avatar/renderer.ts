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
 *  1. Fit-by-height: the rig's `rigHeight` (or, in "bust" framing -- see
 *     `framing` below -- the topology's own `bustFraming.frameHeight`) is
 *     scaled to exactly fill `destRect`'s height, centered horizontally
 *     within its width (so a destRect proportionally wider than the rig
 *     leaves slack on the sides -- expected/fine for a bust-framed portrait
 *     character dropped into a wider box, not a bug).
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
 *     slot. In "bust" framing, a part riding one of the topology's own
 *     `bustFraming.hiddenBoneIndices` (the legs) is skipped outright.
 *  4. Draw every Phase 7 accessory (compiled.accessories) on top of every
 *     part, riding its own anchor bone's already-built world matrix -- also
 *     skipped in "bust" framing when anchored to a hidden bone.
 */
export function drawAvatar(
  ctx: CanvasRenderingContext2D,
  compiled: CompiledAvatar,
  pose: BoneTransform[],
  destRect: { x: number; y: number; width: number; height: number },
  mouthShapeId: string,
  // Phase 8 ("Portrait mode") -- "full" (default, and every call site
  // predating this phase) draws the whole rig exactly as before. "bust"
  // hides the topology's own `bustFraming.hiddenBoneIndices` (the legs, on
  // every seed/generated topology today) and fits-by-height against
  // `bustFraming.frameHeight` instead of the full rig, so hands+torso+head
  // fill the destRect the same way a full body does in "full" framing. A
  // topology with no `bustFraming` at all falls back to full-rig behavior
  // even when "bust" is requested, rather than this function ever erroring.
  framing: "full" | "bust" = "full",
  // Facial expression (eyebrows/eyes) -- keyed by partId ("eyebrows"/"eyes"),
  // each value the shapeId active for that part this frame (e.g.
  // resolveAvatarRenderState.ts's eyebrowShapeId, actions.ts's
  // computeEyeShapeId's eyeShapeId). Deliberately a SEPARATE param from
  // mouthShapeId, not merged into one map -- see CompiledSkin.expressionShapes's
  // own doc comment. Absent, or naming a shapeId this skin doesn't declare,
  // just falls back to that part's own base rect (same graceful-fallback
  // posture as garmentId) -- an older/not-yet-regenerated skin with no
  // "eyebrows"/"eyes" parts is completely unaffected.
  activeExpressionShapeIds?: Record<string, string>
): void {
  if (destRect.width <= 0 || destRect.height <= 0) return;

  const { topology, skin, accessories } = compiled;
  const bustFraming = framing === "bust" ? topology.bustFraming : undefined;
  const hiddenBoneIndices = bustFraming?.hiddenBoneIndices ?? [];

  const scale = destRect.height / (bustFraming?.frameHeight ?? topology.rigHeight);
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

  const drawPart = (part: (typeof skin.parts)[number]): void => {
    // A mouth shape swaps in for whichever `parts` entry is its own slot --
    // recognized here by partId equality against the active mouthShapeId's
    // resolved entry (compile.ts builds every mouthShapes[] entry sharing
    // that same partId with its slot's own `parts` entry -- see
    // CompiledSkin.mouthShapes's own doc comment). Every other part is
    // unaffected by mouthShapeId entirely.
    const activeMouthShape = skin.mouthShapes[mouthShapeId];
    const isMouthSlot = activeMouthShape !== undefined && activeMouthShape.partId === part.partId;

    // Same idea as the mouth substitution above, generalized over whichever
    // partId this skin's own `expressionShapes` declares shapes for (see
    // CompiledSkin.expressionShapes's own doc comment) -- never consulted for
    // the mouth's own part, since a skin never declares expressionShapes for
    // partId "mouth".
    const activeExpressionShapeId = activeExpressionShapeIds?.[part.partId];
    const activeExpressionShape = activeExpressionShapeId ? skin.expressionShapes[part.partId]?.[activeExpressionShapeId] : undefined;

    const atlasRect = isMouthSlot ? activeMouthShape.atlasRect : activeExpressionShape ? activeExpressionShape.atlasRect : part.atlasRect;
    const pivotX = isMouthSlot ? activeMouthShape.pivotX : activeExpressionShape ? activeExpressionShape.pivotX : part.pivotX;
    const pivotY = isMouthSlot ? activeMouthShape.pivotY : activeExpressionShape ? activeExpressionShape.pivotY : part.pivotY;

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
  };

  // Bones in the topology's "arms" group rotate large amounts during
  // gestures (wave/point/hit/facepalm/openArms -- see library.ts's GESTURES,
  // and TALK_EMPHASIZE's own periodic arm raise) that swing the hand up past
  // shoulder height, into the same screen region the head occupies. The
  // static, compile-time zOrder (compile.ts's sortedParts, e.g. library.ts's
  // PLACEHOLDER_SKIN_PARTS) is authored for the REST pose, where arms hang at
  // the sides and never reach the head -- so armL/armR are ordered BELOW head/
  // eyes/eyebrows/mouth there. Once a gesture rotates an arm bone past this
  // threshold, drawing it in that same static position puts the raised
  // hand/arm visibly BEHIND the head instead of in front of it. Deferring
  // those parts to draw last (after every other part, this frame only) fixes
  // that without touching the static zOrder used by every other pose.
  // Below the threshold (e.g. SHRUG's small raise) the arm still doesn't
  // reach the head, so the static zOrder is left alone -- nothing about
  // idle/talk/walk's existing look changes.
  const ARM_RAISED_ROTATION_THRESHOLD_RADIANS = 1.2;
  const armBoneIndices = new Set(topology.armBoneIndices ?? []);
  const deferredRaisedArmParts: (typeof skin.parts)[number][] = [];

  for (const part of skin.parts) {
    if (hiddenBoneIndices.includes(part.boneIndex)) continue;
    // A hand or forearm bone (biped-simple's "handL"/"handR"/"forearmL"/
    // "forearmR") rides one or more levels BELOW an arm bone (its ancestor)
    // and never gets its own rotation keyframed by a gesture/talk-emphasize
    // -- those only ever rotate the ARM bone itself, so a hand/forearm's own
    // local rotation stays 0 even while its owning arm is raised past the
    // head. Checking `part.boneIndex`'s own rotation here would therefore
    // never defer it, leaving it stuck at its static (pre-raise) zOrder --
    // BEHIND the head -- while the arm itself correctly draws in front.
    // Walking UP the parent chain until landing on a bone that's actually in
    // armBoneIndices (rather than assuming exactly one hop, which broke once
    // the elbow bone put hand two levels below arm instead of one) finds
    // whichever bone actually carries the rotation that moved this part, so
    // it defers in lockstep with its own arm regardless of how many bones
    // sit in between.
    let rotationBoneIndex = part.boneIndex;
    while (rotationBoneIndex !== -1 && !armBoneIndices.has(rotationBoneIndex)) {
      rotationBoneIndex = topology.parentIndex[rotationBoneIndex];
    }
    if (rotationBoneIndex !== -1 && Math.abs(pose[rotationBoneIndex].rotation) > ARM_RAISED_ROTATION_THRESHOLD_RADIANS) {
      deferredRaisedArmParts.push(part);
      continue;
    }
    drawPart(part);
  }
  for (const part of deferredRaisedArmParts) {
    drawPart(part);
  }

  // Phase 7 -- accessories always draw AFTER every skin part (a hat sits on
  // top of the head, sunglasses on top of the face), in `accessories`' own
  // declaration order (no z-sorting of their own, unlike skin parts -- see
  // CompiledAvatar.accessories' own doc comment). Each rides its own bone's
  // ALREADY-BUILT world matrix (same one its anchor's owning part used above)
  // translated by its own resolved anchor offset -- so an accessory
  // naturally inherits that bone's current rotation/scale (a hat tilts with
  // a tilted head) rather than needing its own forward-kinematics pass.
  for (const accessory of accessories) {
    if (hiddenBoneIndices.includes(accessory.boneIndex)) continue;
    const boneMatrix = worldMatrices[accessory.boneIndex];
    if (!boneMatrix) continue;
    const anchorMatrix = boneMatrix.translate(accessory.offsetX, accessory.offsetY).rotate(accessory.rotationDegrees);
    ctx.save();
    ctx.transform(anchorMatrix.a, anchorMatrix.b, anchorMatrix.c, anchorMatrix.d, anchorMatrix.e, anchorMatrix.f);
    ctx.drawImage(accessory.image, -accessory.pivotX, -accessory.pivotY, accessory.width, accessory.height);
    ctx.restore();
  }

  ctx.restore();
}
