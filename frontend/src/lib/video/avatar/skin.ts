/**
 * The visual "look" layer of the Avatar animation engine -- see topology.ts's
 * own doc comment for the full Topology/Skin/Design split. A Skin binds to
 * exactly one Topology (`topologyId`) and supplies everything about how that
 * shared skeleton is actually DRAWN: one packed texture atlas, which bone
 * each drawn part rides, and the swappable mouth-shape rects a "talk" action
 * cycles through. Nothing in this file is animation logic -- bone motion
 * lives entirely in topology.ts's ActionCurveSpecs; a Skin only ever changes
 * what gets drawn, never how it moves.
 */
/** A pixel rect within one shared atlas image -- sx/sy is the rect's own
 * top-left corner, same convention CanvasRenderingContext2D.drawImage's own
 * source-rect arguments use. */
export interface AtlasRect {
  sx: number;
  sy: number;
  sWidth: number;
  sHeight: number;
}

/**
 * One drawn body part, riding one bone. `pivotX`/`pivotY` are where that
 * bone's own local origin (0,0) lands WITHIN this part's drawn image --
 * measured in pixels relative to the part's OWN atlas rect's top-left, not
 * the whole atlas. Standard sprite-pivot convention: renderer.ts draws the
 * part's image offset by (-pivotX, -pivotY) so that exact point inside the
 * image ends up sitting at the bone's world position, with the rest of the
 * image extending away from it in whatever direction the art actually needs
 * (a head's pivot near its own bottom edge means the image extends UPWARD
 * from the neck; see library.ts's `biped-simple` skin for the full set of
 * pivot choices and the reasoning behind each).
 *
 * `zOrder` is this part's draw order (ascending) -- skin.ts's `parts` array
 * is authored ALREADY sorted by this (and compile.ts preserves that order
 * rather than re-deriving it), so renderer.ts never needs to sort per frame.
 */
export interface AvatarSkinPart {
  partId: string;
  boneIndex: number;
  pivotX: number;
  pivotY: number;
  zOrder: number;
}

/**
 * One swappable atlas rect for the mouth part slot -- `partId` names WHICH
 * entry in `AvatarSkin.parts` is the mouth (the "slot"), not a separate part
 * of its own; see compile.ts's own doc comment for how a shapeId's rect gets
 * resolved against that same slot's boneIndex/pivot at compile time, and
 * renderer.ts's doc comment for how a shapeId is picked per-frame from
 * actions.ts's `computeMouthShapeId`. Every skin must define at least
 * "closed" and "open" (a plain two-frame mouth-flap -- see
 * placeholderAtlas.ts).
 */
export interface AvatarSkinMouthShape {
  shapeId: string;
  partId: string;
}

/**
 * One swappable atlas rect for a garment (torso outfit) part slot -- the
 * same whole-rect-substitution idea as AvatarSkinMouthShape, except resolved
 * ONCE at compile time (compile.ts) rather than re-picked every frame: an
 * outfit choice doesn't change frame to frame the way a talking mouth does.
 * `partId` names which `AvatarSkin.parts` entry this shape substitutes for
 * ("torso" on every skin today, but keyed the same open way mouth shapes are
 * in case a future topology ever grows a second garment-bearing part). A
 * skin need not declare any garment shapes at all -- and even a Design whose
 * `garmentId` names a shapeId THIS skin doesn't define simply can't be
 * re-outfitted -- compile.ts falls back to that part's own base atlas rect
 * rather than throwing, since an outfit pick is an optional cosmetic choice,
 * not a required structural cross-reference the way a mouth shape's own
 * partId is.
 */
export interface AvatarSkinGarmentShape {
  shapeId: string;
  partId: string;
}

/**
 * One swappable atlas rect for a facial-expression part slot (eyebrows,
 * eyes) -- the same per-frame whole-rect-substitution idea as
 * AvatarSkinMouthShape (re-picked every frame, not resolved once like
 * AvatarSkinGarmentShape), kept as its OWN type/field deliberately separate
 * from mouthShapes rather than folding eyebrows/eyes into that mechanism --
 * the mouth path is lip-sync-critical and this avoids any chance of
 * regressing it. `partId` names which `AvatarSkin.parts` entry this shape
 * substitutes for ("eyebrows" or "eyes"); `shapeId` is picked per-frame by
 * actions.ts/resolveAvatarRenderState.ts and threaded into renderer.ts's
 * `drawAvatar`. A skin need not declare any expression shapes at all -- an
 * older/not-yet-regenerated skin with no "eyebrows"/"eyes" parts simply
 * renders its old baked-in-head look, since compile.ts only validates
 * entries a skin actually declares.
 */
export interface AvatarSkinExpressionShape {
  shapeId: string;
  partId: string;
}

/**
 * One recolorable region of the atlas (Phase 7 -- conversational Design
 * edits, e.g. "make the shirt red"). Deliberately scoped to parts whose
 * ENTIRE drawn rect is a single flat fill color (a skin's shirt/pants, never
 * a multi-color rect like the head, which also bakes in hair + eyes) --
 * compile.ts's recolor step re-tints `targetPartIds`' whole atlas rects via a
 * clipped `source-atop` fill, which would flatten a multi-color rect to one
 * color if used there. `defaultColor` MUST equal whatever color this slot's
 * parts were actually drawn with in the atlas image (placeholderAtlas.ts's
 * resolved palette / avatar_gen's atlas_builder.py) -- it's both "what a
 * Design with no override renders as" and compile.ts's own "does this Design
 * actually need a recolor at all" cheap-skip check.
 */
export interface AvatarSkinColorSlot {
  slotId: string;
  targetPartIds: string[];
  defaultColor: string;
  // Which of the owning Topology's `expressionParams` (topology.ts) can also
  // nudge this slot's color, beyond a Design's own explicit
  // `colorSlotOverrides` -- see ExpressionColorDelta's own doc comment.
  respondsToExpressionParams?: string[];
}

/**
 * The full visual definition bound to one Topology. `atlas.imageRef` is
 * either a real URL or a `data:` URL (this phase's placeholder generator
 * produces the latter, baked from an in-memory canvas -- see
 * placeholderAtlas.ts) -- it's always just a STRING reference here, never a
 * live `CanvasImageSource`; compile.ts is the one place that actually loads
 * it into an `Image`. `atlas.partRects` is keyed by both `AvatarSkinPart.partId`
 * values AND every mouth shape's `shapeId` (mouth shapes are just additional
 * named rects packed into the same atlas image, nothing structurally
 * different about them).
 */
export interface AvatarSkin {
  schemaVersion: 1;
  skinId: string;
  topologyId: string;
  atlas: {
    imageRef: string;
    partRects: Record<string, AtlasRect>;
  };
  // Pre-sorted ascending by zOrder -- see AvatarSkinPart.zOrder's own doc
  // comment for why that matters.
  parts: AvatarSkinPart[];
  mouthShapes: AvatarSkinMouthShape[];
  // Phase 7: optional, possibly entirely absent -- a skin with no color
  // slots simply can't be recolored via `AvatarDesign.colorSlotOverrides`
  // (compile.ts's own recolor step is a no-op for it).
  colorSlots?: AvatarSkinColorSlot[];
  // Phase 8 ("selectable torsos") -- optional, possibly entirely absent: a
  // skin with no garment shapes simply can't be re-outfitted via
  // `AvatarDesign.garmentId` (compile.ts's own resolution just falls back to
  // the base "torso" rect either way).
  garmentShapes?: AvatarSkinGarmentShape[];
  // Facial expression (eyebrows/eyes) -- optional, possibly entirely absent:
  // a skin with none simply keeps its old baked-in-head look, no mood-brow
  // swap or blink (see AvatarSkinExpressionShape's own doc comment).
  expressionShapes?: AvatarSkinExpressionShape[];
}
