/**
 * Phase 7 -- "Conversational Design edits" ('make it fatter', 'add
 * sunglasses', 'make him look more evil'), extended to also cover outfit/
 * action/framing ('put him in a suit', 'have her sit down', 'portrait
 * close-up'). A free-text prompt goes to backend/src/avatar/service.py's
 * edit_avatar_design (same niches/service.py-style calling convention every
 * other LLM-glue endpoint in this codebase uses), which returns a batch of
 * `AvatarEditOp`s already validated/clamped server-side against the SAME
 * closed vocabulary this file describes. `applyAvatarEditOps` below is the
 * one place that actually turns those ops into a new `AvatarDesignOverrides`
 * (design.ts) plus, for the two ops that don't live in an overlay clip's
 * designOverrides at all (setAction/setFraming are plain fields on the clip
 * itself, see video_math.ts's AvatarOverlayClip), the picked action/framing
 * -- called both by AvatarFramingDialog (right after the backend call) and,
 * defensively, kept pure/side-effect-free enough that re-validating an
 * already-validated op here is cheap insurance, not redundant ceremony: an
 * LLM's output reaching this file crossed a network boundary, so treating it
 * as still-untrusted input here (never applying an op this Design's own
 * topology/skin can't actually support) costs nothing and closes off a whole
 * class of "the backend's validation had a bug" failure modes.
 */
import type { AvatarDesignOverrides } from "./design";
import type { AvatarTopology } from "./topology";
import type { AvatarSkin } from "./skin";
import { accessoryAcceptsAnchor, getAccessoryCatalogEntry } from "./accessories";

export type AvatarEditOp =
  | { op: "setBoneScale"; groupId: string; value: number }
  | { op: "setColorSlot"; slotId: string; color: string }
  | { op: "addAccessory"; anchorId: string; accessoryAssetId: string; colorOverride?: string }
  | { op: "removeAccessory"; anchorId: string }
  | { op: "setExpression"; paramId: string; value: number }
  // "shirt" is the sentinel for the base torso with no garmentId (matches
  // AvatarFramingDialog's garmentOptions, whose first entry is `{ id:
  // undefined, label: "Shirt" }`) -- a wire-safe stand-in since garmentId
  // itself is optional/undefined, not a real id, for that base case.
  | { op: "setGarment"; garmentId: string }
  | { op: "setAction"; actionId: string }
  | { op: "setFraming"; framing: "full" | "bust" };

/** What applying a batch of ops actually produces: an updated
 * `AvatarDesignOverrides` for the four/five ops that edit the avatar's own
 * look, plus an optional `action`/`framing` for the two ops that instead
 * target the clip's own defaultAction/framing fields (AvatarFramingDialog
 * applies those via setDefaultAction/setFraming, not onto pendingOverrides).
 * `action`/`framing` are only ever set from the LAST such op in the batch
 * (matching addAccessory's own "replaces, doesn't stack" precedent above --
 * a batch asking for two different actions has no sensible way to keep
 * both). */
export interface ApplyAvatarEditOpsResult {
  overrides: AvatarDesignOverrides;
  action?: string;
  framing?: "full" | "bust";
}

// A generous but sane bound on "how much bigger/smaller" a single
// setBoneScale op may push one bone group -- independent of any one
// topology's own boneGroups (which carry no numeric range of their own,
// unlike an expressionParam's explicit min/max), so this is the one place
// that range is declared. 0.4-2.2 comfortably covers "noticeably
// thinner"/"noticeably bigger" without the rig's proportions breaking down
// into an unrecognizable blob or a sliver.
const MIN_BONE_SCALE = 0.4;
const MAX_BONE_SCALE = 2.2;

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_RE.test(value);
}

function cloneOverrides(current: AvatarDesignOverrides): Required<Pick<AvatarDesignOverrides, "boneScaleOverrides" | "colorSlotOverrides" | "expressionBias">> &
  Pick<AvatarDesignOverrides, "attachedAccessories" | "garmentId"> {
  return {
    boneScaleOverrides: { ...current.boneScaleOverrides },
    colorSlotOverrides: { ...current.colorSlotOverrides },
    expressionBias: { ...current.expressionBias },
    attachedAccessories: current.attachedAccessories ? [...current.attachedAccessories] : [],
    // Carried forward as-is (not reset to undefined) so applying an edit
    // prompt that doesn't mention outfit at all -- the common case -- never
    // silently discards whatever the manual Outfit picker (or an earlier
    // setGarment op) already chose.
    garmentId: current.garmentId,
  };
}

/**
 * Applies `ops` (in order) onto `current` (an overlay clip's existing
 * `designOverrides`, or `{}` for a not-yet-edited avatar), validating each op
 * against `topology`/`skin`/`actionIds` -- the SPECIFIC avatar's own resolved
 * capability set, never a hardcoded global list (per this feature's
 * "per-Topology capability, read at request time" principle). An op naming
 * an unknown group/slot/anchor/accessory/param/action/garment, or carrying a
 * non-numeric/out-of-range value or a malformed color, is silently dropped
 * (logged via console.warn) rather than failing the whole batch -- one bad
 * op from an otherwise reasonable response shouldn't discard every other op
 * the LLM got right. Never mutates `current`; always returns a fresh object.
 */
export function applyAvatarEditOps(
  current: AvatarDesignOverrides,
  ops: AvatarEditOp[],
  topology: AvatarTopology,
  skin: AvatarSkin,
  actionIds: string[]
): ApplyAvatarEditOpsResult {
  const next = cloneOverrides(current);
  const garmentIds = new Set((skin.garmentShapes ?? []).map((shape) => shape.shapeId));
  const actionIdSet = new Set(actionIds);
  let action: string | undefined;
  let framing: "full" | "bust" | undefined;

  for (const op of ops) {
    switch (op.op) {
      case "setBoneScale": {
        if (!topology.boneGroups[op.groupId]) {
          console.warn(`applyAvatarEditOps: unknown bone group "${op.groupId}", dropping op`, op);
          break;
        }
        next.boneScaleOverrides[op.groupId] = clamp(op.value, MIN_BONE_SCALE, MAX_BONE_SCALE);
        break;
      }

      case "setColorSlot": {
        const slot = skin.colorSlots?.find((s) => s.slotId === op.slotId);
        if (!slot) {
          console.warn(`applyAvatarEditOps: unknown color slot "${op.slotId}", dropping op`, op);
          break;
        }
        if (!isValidHexColor(op.color)) {
          console.warn(`applyAvatarEditOps: invalid color "${op.color}" for slot "${op.slotId}", dropping op`, op);
          break;
        }
        next.colorSlotOverrides[op.slotId] = op.color;
        break;
      }

      case "addAccessory": {
        const anchor = topology.anchors.find((a) => a.anchorId === op.anchorId);
        const catalogEntry = getAccessoryCatalogEntry(op.accessoryAssetId);
        if (!anchor || !catalogEntry || !accessoryAcceptsAnchor(catalogEntry, op.anchorId)) {
          console.warn(`applyAvatarEditOps: unresolvable accessory/anchor pair, dropping op`, op);
          break;
        }
        const colorOverride = isValidHexColor(op.colorOverride) ? op.colorOverride : undefined;
        next.attachedAccessories = [
          ...next.attachedAccessories!.filter((a) => a.anchorId !== op.anchorId),
          { anchorId: op.anchorId, accessoryAssetId: op.accessoryAssetId, ...(colorOverride ? { colorOverride } : {}) },
        ];
        break;
      }

      case "removeAccessory": {
        next.attachedAccessories = next.attachedAccessories!.filter((a) => a.anchorId !== op.anchorId);
        break;
      }

      case "setExpression": {
        const spec = topology.expressionParams?.[op.paramId];
        if (!spec) {
          console.warn(`applyAvatarEditOps: unknown expression param "${op.paramId}", dropping op`, op);
          break;
        }
        next.expressionBias[op.paramId] = clamp(op.value, spec.min, spec.max);
        break;
      }

      case "setGarment": {
        if (op.garmentId !== "shirt" && !garmentIds.has(op.garmentId)) {
          console.warn(`applyAvatarEditOps: unknown garment "${op.garmentId}", dropping op`, op);
          break;
        }
        next.garmentId = op.garmentId === "shirt" ? undefined : op.garmentId;
        break;
      }

      case "setAction": {
        if (!actionIdSet.has(op.actionId)) {
          console.warn(`applyAvatarEditOps: unknown action "${op.actionId}", dropping op`, op);
          break;
        }
        action = op.actionId;
        break;
      }

      case "setFraming": {
        if (op.framing !== "full" && op.framing !== "bust") {
          console.warn(`applyAvatarEditOps: unknown framing "${op.framing}", dropping op`, op);
          break;
        }
        framing = op.framing;
        break;
      }

      default:
        console.warn("applyAvatarEditOps: unknown op, dropping", op);
    }
  }

  return { overrides: next, action, framing };
}
