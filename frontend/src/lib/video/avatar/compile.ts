/**
 * The compile step of the Avatar animation engine: turns a raw `{topology,
 * skin, design}` triple (topology.ts/skin.ts/design.ts -- authoring-time,
 * name-keyed, tree-shaped documents) into a `CompiledAvatar` -- flat,
 * index-based structures with no bone names, no re-sorting, and no
 * re-validation needed once compiled. actions.ts and renderer.ts both only
 * ever consume the COMPILED shape; nothing downstream of this file touches
 * an AvatarTopology/AvatarSkin/AvatarDesign directly. This split matters
 * because compilation (validating cross-references, sorting draw order,
 * decoding the atlas image) is exactly the kind of one-time cost that would
 * be wasteful to repeat every frame of a live rAF preview loop or an export's
 * seeked frame loop -- see getCompiledAvatar's own doc comment for how that
 * one-time cost is actually amortized across a whole avatar's lifetime.
 *
 * The schema is a contract, not a suggestion: every cross-reference a
 * Topology/Skin pair makes (a part's boneIndex, a part's atlasRect, a mouth
 * shape's slot) is validated HERE, once, with a clear thrown Error naming
 * the offending id -- never silently clamped or defaulted into a
 * mis-rendered frame. Same philosophy as this repo's DB schema migrations:
 * fail loudly at the boundary, not quietly downstream.
 */
import type { ActionCurveSpec, AvatarTopology, BoneTransform, ExpressionParamSpec } from "./topology";
import type { AtlasRect, AvatarSkin, AvatarSkinColorSlot } from "./skin";
import type { AvatarDesign, AvatarDesignOverrides } from "./design";
import { hasAnyDesignOverride, mergeDesignOverrides } from "./design";
import { getAvatarLibraryEntry } from "./library";
import { fetchGeneratedAvatarEntry } from "./generatedLibrary";
import { getAccessoryCatalogEntry, loadAccessoryImage } from "./accessories";

/** One resolved, ready-to-draw part -- `zOrder` itself is dropped once it's
 * done its one job (deciding this entry's position in the already-sorted
 * `CompiledSkin.parts` array); array order IS the draw order from here on,
 * so renderer.ts never re-sorts per frame. */
export interface CompiledPart {
  partId: string;
  boneIndex: number;
  pivotX: number;
  pivotY: number;
  atlasRect: AtlasRect;
}

/** The bone hierarchy + action library, flattened and validated. */
export interface CompiledTopology {
  topologyId: string;
  boneCount: number;
  // A typed-array copy of AvatarTopology.parentIndex -- the one place in
  // this whole engine a typed array earns its keep: this is read every
  // single frame, for every bone, in actions.ts/renderer.ts's hot loop, and
  // never mutated after compile time.
  parentIndex: Int16Array;
  defaultLocalPose: BoneTransform[];
  actions: Record<string, ActionCurveSpec>;
  rigWidth: number;
  rigHeight: number;
  // Phase 7 -- carried straight through from AvatarTopology (topology.ts),
  // consumed by actions.ts's applyExpressionBoneDeltas (bone deltas) and this
  // file's own computeEffectiveSlotColors (color deltas). Absent for any
  // topology declaring no expression params at all.
  expressionParams?: Record<string, ExpressionParamSpec>;
}

/** The atlas image plus every resolved part/mouth-shape draw entry. */
export interface CompiledSkin {
  skinId: string;
  atlasImage: CanvasImageSource;
  // zOrder-sorted -- see CompiledPart's own doc comment.
  parts: CompiledPart[];
  // Keyed by shapeId ("open"/"closed"/...), each entry sharing the SAME
  // boneIndex/pivot as whichever `parts` entry is that mouth's slot, but
  // with that shape's own atlasRect -- so picking a mouth shape to draw is
  // just picking a different map entry, never a different bone or pivot.
  // See renderer.ts's own doc comment for how a CompiledPart is recognized
  // as "the mouth slot" at draw time.
  mouthShapes: Record<string, CompiledPart>;
}

/** One resolved, ready-to-draw accessory (Phase 7) -- structurally almost
 * identical to CompiledPart, except its position is an ANCHOR's world
 * transform (topology.ts's AvatarAnchor, further nudged by the catalog
 * entry's own `offsetFromAnchor`) rather than a bone's own local pose, since
 * an accessory isn't a moving part of the rig itself. */
export interface CompiledAccessory {
  boneIndex: number;
  offsetX: number;
  offsetY: number;
  image: CanvasImageSource;
  pivotX: number;
  pivotY: number;
  width: number;
  height: number;
}

export interface CompiledAvatar {
  topology: CompiledTopology;
  skin: CompiledSkin;
  // The MERGED Design this avatar was actually compiled against (a resolved
  // library/generated Design, with any per-clip `designOverrides` -- Phase 7,
  // video_math.ts's AvatarOverlayClip -- already layered on via
  // mergeDesignOverrides). actions.ts's computeAvatarPose reads
  // `design.expressionBias` straight off this field, so every call site
  // automatically gets the right per-clip values with no separate threading.
  design: AvatarDesign;
  // Phase 7 -- resolved from `design.attachedAccessories`; empty for any
  // avatar with none. Drawn by renderer.ts after every skin part, in array
  // order (declaration order in `design.attachedAccessories`, no z-sorting
  // needed since accessories are always meant to sit on top).
  accessories: CompiledAccessory[];
}

/** Loads a skin atlas's `imageRef` (a plain URL or a `data:` URL -- both
 * decode identically through `Image`/`decode()`, no branching needed between
 * the two) into a real, drawable image. Split out of compileAvatar only so
 * that function's own body reads as "validate, then load, then resolve" in
 * one place rather than burying the async boundary. */
async function loadAtlasImage(imageRef: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = imageRef;
  // decode() resolves once the image is fully decoded and safe to draw --
  // preferred over an onload handler here since it's already a Promise (no
  // hand-rolled executor) and, unlike onload, also rejects on a decode
  // failure rather than hanging forever.
  await image.decode();
  return image;
}

/** Validates and flattens an AvatarTopology into its compiled form. Throws
 * (rather than silently coping) the moment `parentIndex` violates the
 * "parent appears earlier" invariant every downstream forward-kinematics
 * pass (actions.ts, renderer.ts) depends on to walk bones in a single linear
 * index order. */
function compileTopology(topology: AvatarTopology): CompiledTopology {
  const boneCount = topology.boneNames.length;
  for (let i = 1; i < boneCount; i++) {
    const parent = topology.parentIndex[i];
    // Every non-root bone's parent must be a REAL, already-walked bone index
    // (0 <= parent < i) -- not just "< i". `-1` (the root's own marker) is
    // valid ONLY at index 0; a non-root bone with parent -1 would pass a
    // bare "< i" check (since -1 < i for every i > 0) but then crash
    // renderer.ts's forward-kinematics loop, which indexes straight into
    // `worldMatrices[parentIndex[boneIndex]]` with no bounds check of its
    // own (relying entirely on THIS validation having already ruled it out).
    if (!(parent >= 0 && parent < i)) {
      const boneName = topology.boneNames[i] ?? `#${i}`;
      throw new Error(
        `compileAvatar: topology "${topology.topologyId}" bone "${boneName}" (index ${i}) has parentIndex ${parent}, ` +
          `which does not precede it -- every bone's parent must appear earlier in the array (and be >= 0; only bone 0 may be its own root).`
      );
    }
  }

  return {
    topologyId: topology.topologyId,
    boneCount,
    parentIndex: Int16Array.from(topology.parentIndex),
    defaultLocalPose: topology.defaultLocalPose,
    actions: topology.actions,
    rigWidth: topology.rigWidth,
    rigHeight: topology.rigHeight,
    expressionParams: topology.expressionParams,
  };
}

// Phase 7 -- same sane-bound rationale as edits.ts's own MIN/MAX_BONE_SCALE
// (which validates an incoming edit op against this exact same range before
// it's ever persisted into a Design's boneScaleOverrides) -- clamped again
// here defensively, since this function also runs against a hand-authored or
// otherwise-produced Design this module didn't itself validate.
const MIN_BONE_SCALE = 0.4;
const MAX_BONE_SCALE = 2.2;

/** Applies `design.boneScaleOverrides` (a multiplier keyed by one of
 * `topology.boneGroups`' own ids) onto `compiledTopology.defaultLocalPose`,
 * IN PLACE on `compiledTopology` -- but never in place on the pose ARRAY
 * itself: `topology.defaultLocalPose` (the source this compiled copy started
 * from) is a plain module-scope constant shared by every avatar riding this
 * topology (library.ts's DEFAULT_LOCAL_POSE), so mutating its own bone
 * objects would corrupt every other avatar's rest pose too. When there are no
 * overrides at all this is a no-op and `compiledTopology.defaultLocalPose`
 * keeps pointing at that same shared array -- only a Design that actually
 * carries an override pays for a clone. */
function applyBoneScaleOverrides(
  compiledTopology: CompiledTopology,
  boneGroups: Record<string, number[]>,
  overrides: Record<string, number> | undefined
): void {
  if (!overrides || Object.keys(overrides).length === 0) return;

  const nextPose = compiledTopology.defaultLocalPose.map((pose) => ({ ...pose }));
  for (const [groupId, rawValue] of Object.entries(overrides)) {
    const boneIndices = boneGroups[groupId];
    if (!boneIndices) continue;
    const value = Math.min(Math.max(rawValue, MIN_BONE_SCALE), MAX_BONE_SCALE);
    for (const boneIndex of boneIndices) {
      const pose = nextPose[boneIndex];
      if (!pose) continue;
      nextPose[boneIndex] = { ...pose, scaleX: pose.scaleX * value, scaleY: pose.scaleY * value };
    }
  }
  compiledTopology.defaultLocalPose = nextPose;
}

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** Parses a `#rgb`/`#rrggbb` hex color into 0-255 channels -- both
 * AvatarSkinColorSlot.defaultColor and every color this file ever blends
 * toward/from are always plain hex strings (edits.ts's isValidHexColor
 * already gates anything reaching a Design's colorSlotOverrides), so no
 * other CSS color syntax needs to be understood here. */
function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const value = parseInt(normalized.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (c: number) => Math.round(Math.min(Math.max(c, 0), 255)).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Linearly blends from `a` toward `b` by `t` (0..1) in plain RGB space --
 * good enough for this feature's "nudge a mood color" purpose (a handful of
 * discrete steps between two named endpoints), not meant to be
 * perceptually-uniform color science. */
function lerpHexColor(a: string, b: string, t: number): string {
  const clampedT = clampUnit(t);
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * clampedT, ag + (bg - ag) * clampedT, ab + (bb - ab) * clampedT);
}

/** The final color for every one of `skin.colorSlots`, folding in (in this
 * order) the slot's own `defaultColor`, then `design.colorSlotOverrides`
 * (Phase 7's concrete "setColorSlot" edit op), then any active
 * `topology.expressionParams`' `colorDeltas` targeting that same slot
 * (Phase 7's descriptive/mood edits, e.g. "colorMood") -- resolved ONCE here
 * at compile time (never per-frame: a mood color is a Design-level setting a
 * creator dials in and previews, not something animated frame to frame).
 * Returns null when this skin has no color slots at all, so
 * compileSkin/recolorAtlas can skip the whole recolor path for the common
 * case (most skins, most of the time, carry no override). */
function computeEffectiveSlotColors(skin: AvatarSkin, topology: AvatarTopology, design: AvatarDesign): Record<string, string> | null {
  if (!skin.colorSlots || skin.colorSlots.length === 0) return null;

  const result: Record<string, string> = {};
  for (const slot of skin.colorSlots) {
    let color = design.colorSlotOverrides?.[slot.slotId] ?? slot.defaultColor;

    if (topology.expressionParams && design.expressionBias) {
      for (const [paramId, spec] of Object.entries(topology.expressionParams)) {
        if (!spec.colorDeltas) continue;
        const bias = design.expressionBias[paramId];
        if (!bias) continue;
        for (const colorDelta of spec.colorDeltas) {
          if (colorDelta.slotId !== slot.slotId) continue;
          const magnitude = bias > 0 ? spec.max : spec.min;
          const t = magnitude !== 0 ? Math.abs(bias / magnitude) : 0;
          const target = bias > 0 ? colorDelta.towardColorAtMax : colorDelta.towardColorAtMin;
          color = lerpHexColor(color, target, t);
        }
      }
    }

    result[slot.slotId] = color;
  }
  return result;
}

/** Re-tints `baseImage` into a fresh canvas, one `colorSlots` entry at a
 * time -- clips to each slot's own target part rects (so the tint can never
 * bleed into a neighboring, differently-colored rect packed in the same
 * atlas image) then fills with `source-atop` composition, which only paints
 * over pixels the base image already drew opaque -- exactly a flat-fill
 * sprite's silhouette, leaving its alpha edges (antialiasing) untouched.
 * Never mutates `baseImage` itself (a freshly decoded HTMLImageElement, safe
 * to treat as immutable) -- always returns a NEW canvas, since the same
 * decoded base image may be reused (re-tinted differently) by another
 * avatar/clip riding the same underlying skin with its own different
 * overrides. */
function recolorAtlas(baseImage: HTMLImageElement, colorSlots: AvatarSkinColorSlot[], parts: CompiledPart[], effectiveColors: Record<string, string>): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = baseImage.naturalWidth;
  canvas.height = baseImage.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("recolorAtlas: 2D context unavailable");
  ctx.drawImage(baseImage, 0, 0);

  for (const slot of colorSlots) {
    const color = effectiveColors[slot.slotId];
    if (!color) continue;
    for (const partId of slot.targetPartIds) {
      const part = parts.find((p) => p.partId === partId);
      if (!part) continue;
      const rect = part.atlasRect;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.sx, rect.sy, rect.sWidth, rect.sHeight);
      ctx.clip();
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = color;
      ctx.fillRect(rect.sx, rect.sy, rect.sWidth, rect.sHeight);
      ctx.restore();
    }
  }

  return canvas;
}

/** Validates and resolves an AvatarSkin (against its own already-compiled
 * Topology) into its compiled form, including loading the real atlas image.
 * `effectiveColors` (computeEffectiveSlotColors's output, or null for a skin
 * with no color slots) drives a one-time re-tint (recolorAtlas) of the
 * decoded atlas -- skipped entirely whenever every slot's effective color
 * still equals its own default, so a plain, never-recolored skin costs
 * nothing beyond the plain decode this function already always does. */
async function compileSkin(skin: AvatarSkin, boneCount: number, effectiveColors: Record<string, string> | null): Promise<CompiledSkin> {
  const atlasImage = await loadAtlasImage(skin.atlas.imageRef);

  const sortedParts = [...skin.parts].sort((a, b) => a.zOrder - b.zOrder);
  const compiledParts: CompiledPart[] = sortedParts.map((part) => {
    if (!(part.boneIndex >= 0 && part.boneIndex < boneCount)) {
      throw new Error(`compileAvatar: skin "${skin.skinId}" part "${part.partId}" references out-of-range boneIndex ${part.boneIndex}`);
    }
    const atlasRect = skin.atlas.partRects[part.partId];
    if (!atlasRect) {
      throw new Error(`compileAvatar: skin "${skin.skinId}" part "${part.partId}" has no matching atlas rect`);
    }
    return { partId: part.partId, boneIndex: part.boneIndex, pivotX: part.pivotX, pivotY: part.pivotY, atlasRect };
  });

  const mouthShapes: Record<string, CompiledPart> = {};
  for (const mouthShape of skin.mouthShapes) {
    // The mouth shape's OWN boneIndex/pivot are never authored directly --
    // it always rides whichever `parts` entry is its named slot (see
    // AvatarSkinMouthShape's own doc comment in skin.ts).
    const slotPart = compiledParts.find((part) => part.partId === mouthShape.partId);
    if (!slotPart) {
      throw new Error(`compileAvatar: skin "${skin.skinId}" mouth shape "${mouthShape.shapeId}" references unknown part slot "${mouthShape.partId}"`);
    }
    const atlasRect = skin.atlas.partRects[mouthShape.shapeId];
    if (!atlasRect) {
      throw new Error(`compileAvatar: skin "${skin.skinId}" mouth shape "${mouthShape.shapeId}" has no matching atlas rect`);
    }
    mouthShapes[mouthShape.shapeId] = { partId: slotPart.partId, boneIndex: slotPart.boneIndex, pivotX: slotPart.pivotX, pivotY: slotPart.pivotY, atlasRect };
  }

  let resolvedAtlasImage: CanvasImageSource = atlasImage;
  if (effectiveColors && skin.colorSlots && skin.colorSlots.length > 0) {
    const needsRecolor = skin.colorSlots.some((slot) => effectiveColors[slot.slotId] !== slot.defaultColor);
    if (needsRecolor) resolvedAtlasImage = recolorAtlas(atlasImage, skin.colorSlots, compiledParts, effectiveColors);
  }

  return { skinId: skin.skinId, atlasImage: resolvedAtlasImage, parts: compiledParts, mouthShapes };
}

/** Resolves `design.attachedAccessories` (Phase 7) against `topology.anchors`
 * and avatar/accessories.ts's ACCESSORY_CATALOG -- throws on an unresolvable
 * anchorId/accessoryAssetId pair (same "fail loudly, never silently
 * mis-render" posture every other cross-reference in this file is held to;
 * by the time a Design reaches this function its accessories were already
 * validated once by edits.ts's applyAvatarEditOps, so a failure here means a
 * genuinely malformed persisted Design, worth surfacing loudly). Empty input
 * resolves to an empty array with no image decode at all. */
async function compileAccessories(
  topology: AvatarTopology,
  attachedAccessories: AvatarDesign["attachedAccessories"]
): Promise<CompiledAccessory[]> {
  if (!attachedAccessories || attachedAccessories.length === 0) return [];

  const compiled: CompiledAccessory[] = [];
  for (const attached of attachedAccessories) {
    const anchor = topology.anchors.find((a) => a.anchorId === attached.anchorId);
    const catalogEntry = getAccessoryCatalogEntry(attached.accessoryAssetId);
    if (!anchor || !catalogEntry || catalogEntry.anchorId !== attached.anchorId) {
      throw new Error(
        `compileAvatar: attachedAccessories entry references an unresolvable anchor "${attached.anchorId}"/accessory "${attached.accessoryAssetId}" pair`
      );
    }
    const image = await loadAccessoryImage(catalogEntry, attached.colorOverride);
    compiled.push({
      boneIndex: anchor.boneIndex,
      offsetX: anchor.localOffset.x + catalogEntry.offsetFromAnchor.x,
      offsetY: anchor.localOffset.y + catalogEntry.offsetFromAnchor.y,
      image,
      pivotX: catalogEntry.pivotX,
      pivotY: catalogEntry.pivotY,
      width: catalogEntry.width,
      height: catalogEntry.height,
    });
  }
  return compiled;
}

/** Compiles one `{topology, skin, design}` triple into a ready-to-render
 * CompiledAvatar -- `design` here is expected to already be the FULLY MERGED
 * Design (a resolved library/generated Design with any per-clip
 * `designOverrides` already layered on via mergeDesignOverrides, design.ts),
 * since every Phase 7 override (bone scale, color slots, accessories,
 * expression bias) is applied entirely within this one function. Callers
 * should almost never call this directly -- see getCompiledAvatarForClip
 * below, the cached entry point every other module actually uses. */
export async function compileAvatar(topology: AvatarTopology, skin: AvatarSkin, design: AvatarDesign): Promise<CompiledAvatar> {
  const compiledTopology = compileTopology(topology);
  applyBoneScaleOverrides(compiledTopology, topology.boneGroups, design.boneScaleOverrides);
  const effectiveColors = computeEffectiveSlotColors(skin, topology, design);
  const compiledSkin = await compileSkin(skin, compiledTopology.boneCount, effectiveColors);
  const accessories = await compileAccessories(topology, design.attachedAccessories);
  return { topology: compiledTopology, skin: compiledSkin, design, accessories };
}

// Keyed by either a plain avatarId (== AvatarDesign.designId, the common
// no-override case) or `${avatarId}::${JSON of that clip's designOverrides}`
// (avatarCompileCacheKey below) -- caching the PROMISE rather than only its
// resolved value, so two callers asking for the same avatar+overrides before
// the first compile finishes (e.g. two avatar overlay clips on the same
// timeline mounting in the same tick) share the one in-flight compile
// instead of decoding the same atlas image twice.
const compiledAvatarCache = new Map<string, Promise<CompiledAvatar>>();

/** The cache key getCompiledAvatarForClip/CanvasPlayer.tsx/exportTimeline.ts
 * all key their own per-avatar compiled-result maps by -- exported so those
 * draw loops' own lookup uses the exact same key their own compile effect
 * populated, rather than two independently-derived strings drifting apart.
 * Deliberately collapses to the plain avatarId whenever `designOverrides` is
 * absent/empty, so the overwhelmingly common "this clip's avatar has never
 * been edited" case shares one compiled result across every clip using that
 * avatarId, exactly like before this phase -- only a clip that actually
 * carries edits pays for its own separate compile. */
export function avatarCompileCacheKey(avatarId: string, designOverrides: AvatarDesignOverrides | undefined | null): string {
  if (!hasAnyDesignOverride(designOverrides)) return avatarId;
  return `${avatarId}::${JSON.stringify(designOverrides)}`;
}

/** Resolves+compiles `avatarId` (library.ts's seed library first, falling
 * back to a Phase-6 user-generated avatar via generatedLibrary.ts) WITHOUT
 * any per-clip override -- the plain avatarId is also this function's own
 * cache key. This is what every caller with no clip-specific customization
 * to apply should keep using (gallery thumbnails, the framing dialog's base
 * preview before any edit is made) -- a thin, zero-behavior-change wrapper
 * around getCompiledAvatarForClip. */
export function getCompiledAvatar(avatarId: string): Promise<CompiledAvatar> {
  return getCompiledAvatarForClip(avatarId, undefined);
}

/** Like getCompiledAvatar, but also layers `designOverrides` (Phase 7 --
 * an AvatarOverlayClip's own `designOverrides`, video_math.ts) onto the
 * resolved base Design before compiling (design.ts's mergeDesignOverrides) --
 * the entry point CanvasPlayer.tsx/exportTimeline.ts and
 * AvatarFramingDialog's live edit preview all actually use. Cached under
 * avatarCompileCacheKey(avatarId, designOverrides), so a clip with no
 * overrides still shares the exact same cached compile every OTHER
 * no-override clip/caller using that avatarId already gets via
 * getCompiledAvatar above. */
export function getCompiledAvatarForClip(avatarId: string, designOverrides: AvatarDesignOverrides | undefined | null): Promise<CompiledAvatar> {
  const key = avatarCompileCacheKey(avatarId, designOverrides);
  const cached = compiledAvatarCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const entry = getAvatarLibraryEntry(avatarId) ?? (await fetchGeneratedAvatarEntry(avatarId));
    if (!entry) {
      throw new Error(`getCompiledAvatar: no avatar found in the library for id "${avatarId}"`);
    }
    const design = mergeDesignOverrides(entry.design, designOverrides);
    return compileAvatar(entry.topology, entry.skin, design);
  })();

  // A failed compile (e.g. a transient image-decode failure) shouldn't
  // permanently poison this key's cache entry -- evict on rejection so a
  // later retry gets a fresh attempt instead of the same dead promise
  // forever.
  promise.catch(() => {
    if (compiledAvatarCache.get(key) === promise) compiledAvatarCache.delete(key);
  });

  compiledAvatarCache.set(key, promise);
  return promise;
}
