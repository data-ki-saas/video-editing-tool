/**
 * The thin instance layer of the Avatar animation engine -- see topology.ts's
 * own doc comment for the full Topology/Skin/Design split. A Design is what
 * an `AvatarOverlayClip.avatarId` (a later phase's overlay type) actually
 * resolves against, and what library.ts's seed library entries are built
 * from -- but it is deliberately NOT a copy of the rig or the atlas, only a
 * name/bio plus a small set of override fields layered on top of one
 * `skinId`. This is what makes a future creator-customized "My Avatar" cheap
 * to save (Phase 7): saving one never forks the shared skin or topology, so
 * a later fix to either (a smoother walk cycle, a corrected atlas rect)
 * automatically benefits every Design built on it.
 *
 * The four override fields below (`boneScaleOverrides` onward) are Phase 7's
 * "conversational Design edits" mechanism -- concrete ops ("make it fatter",
 * "add sunglasses") and descriptive/mood edits (translated by the backend
 * into `expressionBias` nudges) both write into ONLY these fields, never the
 * shared Topology/Skin, which is what keeps one creator's edit from ever
 * affecting another creator riding the same base skin. compile.ts is what
 * actually reads and applies them (bone-scale/expression-bone-deltas at pose
 * time, color-slot/expression-color-deltas as a one-time atlas recolor,
 * accessories as extra compiled draw entries) -- see that file's own doc
 * comment for the full mechanics, and edits.ts for how a free-text prompt
 * turns into a validated batch of writes to these same fields.
 */
export interface AvatarDesign {
  schemaVersion: 1;

  // This IS the id an AvatarOverlayClip.avatarId resolves against (a later
  // phase's overlay type -- not present yet in this phase).
  designId: string;

  skinId: string;

  meta: {
    name: string;
    bio?: string;
    thumbnail?: string;
  };

  // A multiplier keyed by one of the owning Topology's `boneGroups` ids
  // (topology.ts) -- e.g. a "make it fatter/taller" edit (edits.ts's
  // "setBoneScale" op). Applied to every bone in that group's own rest-pose
  // scaleX/scaleY at compile time (compile.ts's applyBoneScaleOverrides).
  boneScaleOverrides?: Record<string, number>;

  // A recolor keyed by a skin-declared color slot id (skin.ts's
  // AvatarSkinColorSlot) -- edits.ts's "setColorSlot" op. Applied at compile
  // time as a one-time atlas re-tint (compile.ts's computeEffectiveSlotColors
  // + recolorAtlas), never per-frame.
  colorSlotOverrides?: Record<string, string>;

  // Per-instance attachments, each resolving against one of the owning
  // Topology's `anchors` (topology.ts) and one of avatar/accessories.ts's
  // ACCESSORY_CATALOG entries -- edits.ts's "addAccessory"/"removeAccessory"
  // ops. At most one entry per anchorId (a second "addAccessory" at the same
  // anchor replaces, never stacks).
  attachedAccessories?: { anchorId: string; accessoryAssetId: string; colorOverride?: string }[];

  // Current value for each of the owning Topology's `expressionParams`
  // (topology.ts) this Design has been nudged on -- edits.ts's
  // "setExpression" op, e.g. a descriptive "make him look more evil" prompt
  // translating to `{ browAngle: 0.8, colorMood: 0.6 }`. A paramId absent
  // here simply sits at that param's own declared `default`.
  expressionBias?: Record<string, number>;

  // Phase 8 ("selectable torsos") -- one of the owning Skin's own
  // `garmentShapes` (skin.ts) shapeIds ("polo"/"suit"/"blazer"), or
  // absent/unresolvable for the base "torso" rect every skin already has
  // (see AvatarSkinGarmentShape's own doc comment for the exact fallback
  // rule). A plain single field, not a Record like colorSlotOverrides,
  // since there's only ever one outfit choice active at a time -- not one
  // per color slot.
  garmentId?: string;
}

/**
 * The subset of AvatarDesign Phase 7 edits actually write -- everything a
 * creator's customization can touch, layered on top of a shared library
 * Design/Skin/Topology without ever forking them. This is also exactly the
 * shape `AvatarOverlayClip.designOverrides` (video_math.ts) persists: a
 * per-CLIP override on top of whichever avatarId that clip resolves against,
 * the same "small override record layered on shared content" idea Design
 * itself already applies one level up (over Skin).
 */
export type AvatarDesignOverrides = Pick<
  AvatarDesign,
  "boneScaleOverrides" | "colorSlotOverrides" | "attachedAccessories" | "expressionBias" | "garmentId"
>;

/** True when `overrides` actually carries at least one real override --
 * `{}`, or an object whose Record fields are all empty and whose
 * `attachedAccessories` (if present) is empty, counts as "no overrides at
 * all." Shared by mergeDesignOverrides below, compile.ts's
 * avatarCompileCacheKey (an empty-but-present designOverrides shouldn't fork
 * a separate cache entry from the plain avatarId), and
 * AvatarFramingDialog's own Save (so a dialog opened and closed without any
 * actual edit doesn't start persisting an empty override object onto the
 * clip). */
export function hasAnyDesignOverride(overrides: AvatarDesignOverrides | undefined | null): overrides is AvatarDesignOverrides {
  if (!overrides) return false;
  return Boolean(
    (overrides.boneScaleOverrides && Object.keys(overrides.boneScaleOverrides).length > 0) ||
      (overrides.colorSlotOverrides && Object.keys(overrides.colorSlotOverrides).length > 0) ||
      (overrides.expressionBias && Object.keys(overrides.expressionBias).length > 0) ||
      (overrides.attachedAccessories && overrides.attachedAccessories.length > 0) ||
      Boolean(overrides.garmentId)
  );
}

/** Layers `overrides` onto `base` (a resolved library/generated Design) --
 * per-field shallow merge for the two Record fields (an override REPLACES
 * only the keys it names, e.g. a "pantsColor" override doesn't clear a
 * separately-set "shirtColor" one), plain replacement for
 * `attachedAccessories` (a full list, not keyed, so there's nothing sensible
 * to merge key-by-key). Returns `base` unchanged (same reference) when there
 * are no overrides at all, so a plain, never-edited clip costs nothing extra
 * to resolve. */
export function mergeDesignOverrides(base: AvatarDesign, overrides: AvatarDesignOverrides | undefined | null): AvatarDesign {
  if (!hasAnyDesignOverride(overrides)) return base;
  return {
    ...base,
    boneScaleOverrides: { ...base.boneScaleOverrides, ...overrides.boneScaleOverrides },
    colorSlotOverrides: { ...base.colorSlotOverrides, ...overrides.colorSlotOverrides },
    expressionBias: { ...base.expressionBias, ...overrides.expressionBias },
    attachedAccessories: overrides.attachedAccessories ?? base.attachedAccessories,
    garmentId: overrides.garmentId ?? base.garmentId,
  };
}
