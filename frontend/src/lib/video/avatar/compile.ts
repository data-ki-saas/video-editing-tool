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
import type { ActionCurveSpec, AvatarTopology, BoneTransform } from "./topology";
import type { AtlasRect, AvatarSkin } from "./skin";
import type { AvatarDesign } from "./design";
import { getAvatarLibraryEntry } from "./library";
import { fetchGeneratedAvatarEntry } from "./generatedLibrary";

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

export interface CompiledAvatar {
  topology: CompiledTopology;
  skin: CompiledSkin;
  // Carried through uncompiled -- this phase's Design has nothing that
  // NEEDS flattening (its override fields are all unused stubs, see
  // design.ts's own doc comment); kept here rather than dropped so a later
  // phase's renderer/compile changes have it in hand without threading a
  // second parameter through every call site.
  design: AvatarDesign;
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
  };
}

/** Validates and resolves an AvatarSkin (against its own already-compiled
 * Topology) into its compiled form, including loading the real atlas image. */
async function compileSkin(skin: AvatarSkin, boneCount: number): Promise<CompiledSkin> {
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

  return { skinId: skin.skinId, atlasImage, parts: compiledParts, mouthShapes };
}

/** Compiles one `{topology, skin, design}` triple into a ready-to-render
 * CompiledAvatar. Callers should almost never call this directly -- see
 * getCompiledAvatar below, the cached entry point every other module
 * actually uses. */
export async function compileAvatar(topology: AvatarTopology, skin: AvatarSkin, design: AvatarDesign): Promise<CompiledAvatar> {
  const compiledTopology = compileTopology(topology);
  const compiledSkin = await compileSkin(skin, compiledTopology.boneCount);
  return { topology: compiledTopology, skin: compiledSkin, design };
}

// Keyed by avatarId (== AvatarDesign.designId), caching the PROMISE rather
// than only its resolved value -- two callers asking for the same avatar
// before the first compile finishes (e.g. two avatar overlay clips on the
// same timeline mounting in the same tick) share the one in-flight compile
// instead of decoding the same atlas image twice.
const compiledAvatarCache = new Map<string, Promise<CompiledAvatar>>();

/** The ONLY function other modules should call to get a usable
 * CompiledAvatar -- resolves `avatarId` against library.ts's seed library
 * first (synchronous, in-memory), then falls back to fetching a Phase-6
 * user-generated avatar (generatedLibrary.ts, backend/src/avatar_gen/) if
 * that misses -- compiles it once either way, and reuses that compiled
 * result (and in-flight promise) for every later call with the same id for
 * the lifetime of this page load. */
export function getCompiledAvatar(avatarId: string): Promise<CompiledAvatar> {
  const cached = compiledAvatarCache.get(avatarId);
  if (cached) return cached;

  const promise = (async () => {
    const entry = getAvatarLibraryEntry(avatarId) ?? (await fetchGeneratedAvatarEntry(avatarId));
    if (!entry) {
      throw new Error(`getCompiledAvatar: no avatar found in the library for id "${avatarId}"`);
    }
    return compileAvatar(entry.topology, entry.skin, entry.design);
  })();

  // A failed compile (e.g. a transient image-decode failure) shouldn't
  // permanently poison this id's cache entry -- evict on rejection so a
  // later retry gets a fresh attempt instead of the same dead promise
  // forever.
  promise.catch(() => {
    if (compiledAvatarCache.get(avatarId) === promise) compiledAvatarCache.delete(avatarId);
  });

  compiledAvatarCache.set(avatarId, promise);
  return promise;
}
