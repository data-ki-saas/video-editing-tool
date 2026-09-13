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
}
