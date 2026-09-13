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
 * The four override fields below (`boneScaleOverrides` onward) are ALL
 * unused in this phase -- declared now because retrofitting them onto every
 * already-authored/persisted Design later would be the breaking-schema-change
 * this file's sibling docs keep warning against, not because anything here
 * reads them yet. No code in this phase should read or branch on them.
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

  // Future per-instance override: a multiplier keyed by one of the owning
  // Topology's `boneGroups` ids (topology.ts) -- e.g. a "make it fatter/
  // taller" edit. Unused in this phase.
  boneScaleOverrides?: Record<string, number>;

  // Future per-instance override: a recolor keyed by a skin-declared color
  // slot id. Unused in this phase (this phase's AvatarSkin has no color-slot
  // concept at all yet -- see skin.ts).
  colorSlotOverrides?: Record<string, string>;

  // Future per-instance attachments, each resolving against one of the
  // owning Topology's `anchors` (topology.ts). Unused in this phase.
  attachedAccessories?: { anchorId: string; accessoryAssetId: string; colorOverride?: string }[];

  // Future per-instance bias toward a Topology-declared expression param
  // (topology.ts deliberately has no `expressionParams` yet either -- see
  // its own doc comment). Unused in this phase.
  expressionBias?: Record<string, number>;
}
