"use client";

/**
 * "Pick a character, pick what it's doing, drop it on the frame" popup for
 * avatar overlays -- clones TextOverlayDialog.tsx's own split-pane shape
 * (see that file's module comment) since an AvatarOverlayClip is the same
 * plain positioned-rect-plus-time-range content as a TextOverlay (see
 * video_math.ts's own doc comment on why it deliberately isn't built on
 * VideoOverlayLayout's Full-Screen/Picture-in-Picture/Split-Screen system).
 * Used both for adding a new overlay (editingOverlay is null, defaults to
 * the library's first entry and the "idle" action) and for editing an
 * existing one's character/action/position (pre-filled, reopened via
 * AvatarOverlayTrack's "Edit avatar" or a plain click on its segment).
 *
 * Left half: same live frame preview + draggable/resizable rect overlay as
 * TextOverlayDialog, except the rect's own content is a LIVE, animated
 * canvas of the currently-picked character performing the currently-picked
 * action (AvatarPreviewCanvas below) instead of a static template render --
 * "see what you're placing before committing," same live-preview-inside-a-
 * dialog pattern this codebase already uses for CutawayDialog's camera3D/
 * faceEffect/ambientEffect pickers, just driven by the Avatar engine
 * (getCompiledAvatar/computeAvatarPose/computeMouthShapeId/drawAvatar --
 * the exact same functions CanvasPlayer.tsx's own avatar-overlay draw loop
 * calls) instead of that dialog's photo+effect pipeline.
 *
 * Right half: a character gallery (AVATAR_LIBRARY, avatar/library.ts) --
 * built as a real grid rather than a single hardcoded card, so a later
 * phase's larger library (user-generated avatars) drops in with no
 * structural change here -- and an action grid derived from the CURRENTLY
 * SELECTED avatar's own resolved topology (human-readable labels, see
 * AVATAR_ACTION_LABELS below), not a fixed six-button layout: a Topology
 * may declare extra actions beyond the six-id baseline (topology.ts's own
 * `AvatarTopology.actions` doc comment), and this picker needs to offer
 * whichever set the picked character's own rig actually has. No free-typed
 * content field at all (unlike TextOverlayDialog's textarea): everything
 * this overlay carries is a pick from a fixed set, per this feature's own
 * spec -- EXCEPT the Phase 7 "Customize with AI" prompt below the left-pane
 * preview, this dialog's one free-text input, which edits pendingOverrides
 * (avatar/edits.ts's applyAvatarEditOps) rather than avatarId/defaultAction/
 * rect themselves.
 */
import { useEffect, useRef, useState } from "react";
import { OverlayRectOverlay } from "./OverlayRectOverlay";
import { InlineEditableText } from "@/components/InlineEditableText";
import { UpgradeRequiredDialog } from "@/components/UpgradeRequiredDialog";
import { getCompiledAvatar, getCompiledAvatarForClip, type CompiledAvatar } from "@/lib/video/avatar/compile";
import { computeAvatarPose, computeMouthShapeId } from "@/lib/video/avatar/actions";
import { drawAvatar } from "@/lib/video/avatar/renderer";
import { AVATAR_LIBRARY, BIPED_SIMPLE_TOPOLOGY, getAvatarLibraryEntry } from "@/lib/video/avatar/library";
import {
  deleteGeneratedAvatar,
  fetchGeneratedAvatarEntry,
  generateAvatarFromPhoto,
  listMyGeneratedAvatars,
  renameGeneratedAvatar,
  type GeneratedAvatarSummary,
} from "@/lib/video/avatar/generatedLibrary";
import type { AvatarActionId, AvatarTopology } from "@/lib/video/avatar/topology";
import type { AvatarSkin } from "@/lib/video/avatar/skin";
import { hasAnyDesignOverride, type AvatarDesignOverrides } from "@/lib/video/avatar/design";
import { applyAvatarEditOps } from "@/lib/video/avatar/edits";
import { ACCESSORY_CATALOG } from "@/lib/video/avatar/accessories";
import { ambientEffectSeed } from "@/lib/video/ambientEffects";
import {
  DEFAULT_AVATAR_OVERLAY_RECT,
  findOverlappingTtsOverlay,
  type AvatarAction,
  type AvatarOverlayClip,
  type CropRect,
  type TtsOverlay,
} from "@/lib/video/video_math";
import { directAvatarActions, editAvatarDesign, FeatureLockedError } from "@/lib/api";
import { usePermissions } from "@/lib/usePermissions";

// A Phase-6 generated avatarId always has this prefix (see
// backend/src/avatar_gen/service.py's own design_id construction) -- every
// generated Skin binds to the exact same shared "biped-simple" topology
// every seed character rides, so its action set is known statically without
// an async fetch (see actionIdsForAvatar below).
const GENERATED_AVATAR_ID_PREFIX = "gen-";

// Human-readable labels for the six baseline actions (topology.ts's
// AvatarActionId) plus this feature's own first non-baseline extra
// ("talkEmphasize" -- see library.ts's own doc comment on "biped-simple"'s
// action map). A Topology may declare further extras beyond even this map,
// which is exactly why this is a plain lookup with a humanizing fallback
// (see humanizeActionId/actionLabel below) rather than a closed set this
// component would need another patch to extend.
const AVATAR_ACTION_LABELS: Record<string, string> = {
  idle: "Idle",
  talk: "Talking",
  walk: "Walking",
  sit: "Sitting",
  sleep: "Sleeping",
  lookAround: "Looking around",
  talkEmphasize: "Talking + Pointing",
};

// Phase 8 ("selectable torsos") -- human-readable labels for the garment
// shapeIds library.ts's GARMENT_SHAPES/avatar_gen's own _GARMENT_SHAPES
// declare. "Shirt" (id `undefined`) isn't in here -- see garmentOptions
// below for why it's a separate, always-first synthetic entry rather than a
// real shapeId.
const GARMENT_LABELS: Record<string, string> = {
  polo: "Polo",
  suit: "Suit",
  blazer: "Blazer",
};

// Defensive fallback ONLY -- used if getAvatarLibraryEntry can't resolve the
// currently-picked avatarId at all (see actionIdsForAvatar below). Every
// real seed Topology defines all six baseline actions (library.ts's own doc
// comment), so this path isn't expected to matter in practice.
const BASELINE_ACTION_IDS: AvatarActionId[] = ["idle", "talk", "walk", "sit", "sleep", "lookAround"];

// "someNewAction" -> "Some New Action" -- last-resort label for any action
// id AVATAR_ACTION_LABELS doesn't know about yet, so a future Topology's
// extra action (topology.ts's own "actions" doc comment) shows up looking
// reasonable in this picker without another round of UI changes here.
function humanizeActionId(actionId: string): string {
  const spaced = actionId.replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  if (spaced === "") return actionId;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function actionLabel(actionId: string): string {
  return AVATAR_ACTION_LABELS[actionId] ?? humanizeActionId(actionId);
}

function garmentLabel(shapeId: string): string {
  return GARMENT_LABELS[shapeId] ?? humanizeActionId(shapeId);
}

// The actual pickable action ids for whichever avatar is CURRENTLY
// selected -- derived from that avatar's own resolved topology (Object.keys
// of its `actions` map, which preserves the insertion order library.ts
// authored it in: baseline six first, extras after) rather than a fixed
// array, so a richer topology's extra actions show up here with no further
// change to this component. Falls back to the baseline six only if the
// lookup itself fails (see BASELINE_ACTION_IDS's own comment).
function actionIdsForAvatar(avatarId: string): string[] {
  const topology =
    getAvatarLibraryEntry(avatarId)?.topology ??
    (avatarId.startsWith(GENERATED_AVATAR_ID_PREFIX) ? BIPED_SIMPLE_TOPOLOGY : null);
  const actionIds = Object.keys(topology?.actions ?? {});
  return actionIds.length > 0 ? actionIds : BASELINE_ACTION_IDS;
}

/**
 * One static HEAD-ONLY crop per gallery card -- deliberately NOT
 * drawAvatar's full-body bone/pose pipeline (used for the live left-pane
 * preview and the real editor canvas, where a full-body character genuinely
 * belongs). A picker's job is "which face is this," and drawAvatar's
 * "fit the whole rig by height" scaling, applied to this card's small
 * aspect-[9/16] box, shrinks the head part to a sliver of its own 140px
 * source size -- fine detail (eyes, eyebrows, the Phase-6-generated
 * contour features) doesn't survive that downscale, even though the
 * source atlas itself renders them correctly (confirmed by inspecting a
 * generated atlas PNG directly). So this bypasses bones/pose entirely and
 * draws the "head" CompiledPart's own atlasRect straight from the atlas
 * image, scaled to fill the card by its own aspect ratio (contain-fit,
 * top-anchored so there's breathing room below rather than dead space
 * above) -- the head fills the thumbnail the way a profile picture would,
 * not a tiny figure standing in a tall box. The mouth is a SEPARATE
 * CompiledPart (its own atlasRect, drawn from mouthShapes.closed for a
 * static idle look) that isn't inside the head's own atlasRect at all --
 * omitting it was an oversight in the first version of this fix. Both
 * "head" and "mouth" ride the SAME bone in every topology this app has
 * (biped-simple), so their relative position is just their PIVOT
 * difference, without needing the full bone/world-matrix machinery
 * renderer.ts's drawAvatar uses: drawImage places a part such that its own
 * (pivotX, pivotY) lands at the bone's world origin, so two same-bone
 * parts' top-left corners differ by exactly (partA.pivot - partB.pivot) --
 * see the mouthDestX/Y math below. Skipped (falls back to head-only) if a
 * future topology ever puts the mouth on a different bone.
 */
function AvatarThumbnailCanvas({ avatarId, className }: { avatarId: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    getCompiledAvatar(avatarId)
      .then((compiled) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const width = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
        const height = Math.max(1, Math.round(canvas.getBoundingClientRect().height));
        // Render at devicePixelRatio so fine features (thin eyebrow
        // strokes, small eye shapes) get real source pixels to downscale
        // from instead of blurring away on a high-DPI screen.
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const headPart = compiled.skin.parts.find((part) => part.partId === "head");
        if (!headPart) return;
        const { atlasRect } = headPart;
        const scale = Math.min(width / atlasRect.sWidth, height / atlasRect.sHeight);
        const drawWidth = atlasRect.sWidth * scale;
        const drawHeight = atlasRect.sHeight * scale;
        const destX = (width - drawWidth) / 2;
        const destY = Math.max(0, (height - drawHeight) * 0.15); // top-anchored, not dead-centered
        ctx.drawImage(
          compiled.skin.atlasImage,
          atlasRect.sx,
          atlasRect.sy,
          atlasRect.sWidth,
          atlasRect.sHeight,
          destX,
          destY,
          drawWidth,
          drawHeight
        );

        const mouthPart = compiled.skin.mouthShapes.closed ?? compiled.skin.parts.find((part) => part.partId === "mouth");
        if (mouthPart && mouthPart.boneIndex === headPart.boneIndex) {
          const mouthRect = mouthPart.atlasRect;
          const mouthDestX = destX + (headPart.pivotX - mouthPart.pivotX) * scale;
          const mouthDestY = destY + (headPart.pivotY - mouthPart.pivotY) * scale;
          ctx.drawImage(
            compiled.skin.atlasImage,
            mouthRect.sx,
            mouthRect.sy,
            mouthRect.sWidth,
            mouthRect.sHeight,
            mouthDestX,
            mouthDestY,
            mouthRect.sWidth * scale,
            mouthRect.sHeight * scale
          );
        }
      })
      .catch((err) => {
        console.error("Avatar thumbnail compile failed for avatarId=%s", avatarId, err);
      });
    return () => {
      cancelled = true;
    };
  }, [avatarId]);

  return <canvas ref={canvasRef} className={className} />;
}

/**
 * The dialog's one live preview canvas -- a pure rAF loop over a
 * free-running elapsed clock (no seek/frame-index bookkeeping needed, since
 * computeAvatarPose/computeMouthShapeId are pure functions of elapsed time,
 * see actions.ts's own module comment), redrawing every frame with whatever
 * `avatarId`/`action` this dialog currently has picked.
 *
 * `avatarId` and `action` are read from refs inside the loop rather than
 * captured by the effect that starts it, so switching the picked CHARACTER
 * never restarts the clock (a skin swap mid-loop should look like changing
 * the costume on a doll already in motion, not rewinding it) while
 * switching the picked ACTION deliberately does restart it (see that
 * effect's own comment) -- each needs a different amount of continuity.
 * getCompiledAvatar is itself promise-cached (compile.ts), so flipping back
 * to an already-picked avatarId resolves instantly with no re-decode.
 */
function AvatarPreviewCanvas({
  avatarId,
  action,
  designOverrides,
  framing,
  className,
}: {
  avatarId: string;
  action: string;
  // Phase 7 -- this dialog's own in-progress "Edit with AI" customization
  // (pendingOverrides), previewed live via getCompiledAvatarForClip instead
  // of the plain id-only getCompiledAvatar every OTHER caller of this
  // component (gallery thumbnails) still uses. Omitted entirely for those
  // callers, which behave exactly as before this phase.
  designOverrides?: AvatarDesignOverrides;
  // Phase 8 ("Portrait mode") -- previewed live the same way, defaulting to
  // "full" so every pre-Phase-8 caller (there are none besides this dialog,
  // but the default keeps this prop genuinely optional) is unaffected.
  framing?: "full" | "bust";
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compiledRef = useRef<CompiledAvatar | null>(null);
  const seedRef = useRef(0);
  // Read fresh every frame by the rAF loop below without being one of its
  // OWN restart triggers -- same "ref, not a dependency" treatment as
  // avatarId itself (see the loop's own comment): toggling Full body/
  // Portrait mid-preview should re-frame the very next drawn frame, not
  // rewind the animation clock the way switching ACTION deliberately does.
  const framingRef = useRef<"full" | "bust">(framing ?? "full");
  useEffect(() => {
    framingRef.current = framing ?? "full";
  }, [framing]);

  // (Re)compiles whenever the picked avatarId OR its pending overrides
  // change. `cancelled` guards against a stale resolution landing after the
  // user has since picked a DIFFERENT avatar (or this dialog has since
  // closed/unmounted) -- compiledRef is simply never written in that case,
  // so the loop below keeps drawing whatever it already had (or nothing, if
  // this is the first pick) instead of a wrong, late-arriving character.
  useEffect(() => {
    let cancelled = false;
    compiledRef.current = null;
    // Seeded off the avatarId (not a per-clip id -- this dialog has no
    // AvatarOverlayClip.id to key off yet for a brand-new "Add") purely so
    // the lookAround action's gaze animation looks deliberate rather than
    // frozen; CanvasPlayer.tsx's own real playback seeds off the eventual
    // clip's own stable id instead (see that file's own comment) -- a
    // preview seed that differs slightly from the committed clip's is
    // harmless, since lookAround's exact gaze timing was never meant to be
    // reproduced pixel-for-pixel between the two.
    seedRef.current = ambientEffectSeed(avatarId);
    if (!avatarId) return;
    getCompiledAvatarForClip(avatarId, designOverrides)
      .then((compiled) => {
        if (!cancelled) compiledRef.current = compiled;
      })
      .catch((err) => {
        console.error("Avatar preview compile failed for avatarId=%s", avatarId, err);
      });
    return () => {
      cancelled = true;
    };
  }, [avatarId, designOverrides]);

  // Crisp resolution matched to the canvas's own rendered CSS size -- same
  // convention as TextOverlayCanvas.tsx (this dialog's rect can be resized,
  // so a fixed internal resolution would go soft/blocky as it grows).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      canvas.width = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
      canvas.height = Math.max(1, Math.round(canvas.getBoundingClientRect().height));
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Own rAF loop, restarted only when `action` changes (a fresh action
  // starts its own loop from t=0 rather than resuming mid-cycle, which
  // reads as "you just picked this" rather than a jump-cut into an
  // arbitrary phase) -- cleaned up on every restart AND on unmount, so this
  // dialog never leaves a stray loop running after it closes.
  useEffect(() => {
    let rafId: number;
    let startTimestamp: number | null = null;

    function draw(timestamp: number) {
      if (startTimestamp === null) startTimestamp = timestamp;
      const elapsedSeconds = (timestamp - startTimestamp) / 1000;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const compiled = compiledRef.current;
        if (compiled) {
          const pose = computeAvatarPose(compiled.topology, action, elapsedSeconds, seedRef.current, compiled.design.expressionBias);
          const mouthShapeId = computeMouthShapeId(action, elapsedSeconds);
          drawAvatar(ctx, compiled, pose, { x: 0, y: 0, width: canvas.width, height: canvas.height }, mouthShapeId, framingRef.current);
        }
      }
      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [action]);

  return <canvas ref={canvasRef} className={className} />;
}

export function AvatarFramingDialog({
  editingOverlay,
  previewFrameUrl,
  frameAspectRatio,
  ttsOverlays,
  onSave,
  onClose,
  onDelete,
  onDirect,
}: {
  editingOverlay: AvatarOverlayClip | null;
  previewFrameUrl: string | null;
  frameAspectRatio: number | null;
  // Needed only for "Direct with AI" below (findOverlappingTtsOverlay) --
  // every other prop here is unrelated to narration.
  ttsOverlays: TtsOverlay[];
  // `designOverrides` (Phase 7) is only ever passed when this dialog's own
  // "Edit with AI" panel actually produced at least one real override --
  // omitted (not an empty `{}`) otherwise, so a never-customized avatar's
  // clip stays exactly as lean as before this phase (see design.ts's
  // hasAnyDesignOverride).
  onSave: (
    avatarId: string,
    defaultAction: AvatarActionId | (string & {}),
    rect: CropRect,
    designOverrides?: AvatarDesignOverrides,
    framing?: "full" | "bust"
  ) => void;
  onClose: () => void;
  // Only ever passed (and only ever rendered, see the button row below) when
  // editingOverlay is non-null -- a not-yet-added avatar has nothing to
  // delete yet. Same optional, edit-only "Remove" affordance as
  // TextSlideDialog's own onDelete.
  onDelete?: () => void;
  // "Direct with AI" (Phase 4) -- persists the returned actionTimeline onto
  // THIS overlay via its own dedicated transformation (applyDirectAvatarOverlay),
  // never folded into onSave since direction doesn't touch avatarId/
  // defaultAction/rect at all. Same "only when editing an already-added
  // overlay" gating as onDelete -- a brand-new, not-yet-saved overlay has no
  // committed time range yet for findOverlappingTtsOverlay to match against.
  onDirect?: (actionTimeline: AvatarAction[]) => void;
}) {
  const [avatarId, setAvatarId] = useState(editingOverlay?.avatarId ?? AVATAR_LIBRARY[0]?.design.designId ?? "");
  // Widened to plain `string` (rather than AvatarActionId) because the
  // picker below is driven off whatever action ids the SELECTED avatar's own
  // topology actually declares, which can include extras beyond the six
  // baseline ids (see AVATAR_ACTION_LABELS's own comment above) -- matches
  // AvatarOverlayClip.defaultAction's own widened type (video_math.ts).
  const [defaultAction, setDefaultAction] = useState<string>(editingOverlay?.defaultAction ?? "idle");
  const [rect, setRect] = useState<CropRect>(editingOverlay?.rect ?? DEFAULT_AVATAR_OVERLAY_RECT);
  // Phase 8 ("Portrait mode") -- "full" (whole rig) vs. "bust" (hands+torso+
  // head, legs cropped out -- see avatar/topology.ts's AvatarBustFraming).
  // A plain crop choice, independent of `defaultAction`: the existing "sit"
  // action is a different animated POSE (the character sitting), not this
  // framing -- a creator can combine either action with either framing.
  const [framing, setFraming] = useState<"full" | "bust">(editingOverlay?.framing ?? "full");
  // Phase 7 -- this clip's own bone-scale/color-slot/accessory/expression-bias
  // customization, edited in place via "Edit with AI" and previewed live
  // (AvatarPreviewCanvas below) before ever being committed to the clip on
  // Save. Starts from whatever the overlay being edited already carries.
  const [pendingOverrides, setPendingOverrides] = useState<AvatarDesignOverrides>(editingOverlay?.designOverrides ?? {});

  // Re-syncs if a different overlay is opened for editing (or the dialog is
  // reopened fresh for "Add") while already mounted -- same convention as
  // TextOverlayDialog/TtsOverlayDialog's own re-sync effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAvatarId(editingOverlay?.avatarId ?? AVATAR_LIBRARY[0]?.design.designId ?? "");
    setDefaultAction(editingOverlay?.defaultAction ?? "idle");
    setRect(editingOverlay?.rect ?? DEFAULT_AVATAR_OVERLAY_RECT);
    setPendingOverrides(editingOverlay?.designOverrides ?? {});
    setFraming(editingOverlay?.framing ?? "full");
  }, [editingOverlay]);

  // Switching to a DIFFERENT character mid-dialog clears any pending
  // customization -- a bone-scale/color-slot override tuned for one skin has
  // no guaranteed meaning against another's (different boneGroups/colorSlots
  // ids), and silently carrying it across would be confusing even where it
  // happens to still resolve (compile.ts just ignores an override whose
  // id isn't present on the new skin/topology, but that's a safety net, not
  // a feature). Every direct `setAvatarId` call below except the re-sync
  // effect above goes through this instead of calling setAvatarId directly.
  function selectAvatar(id: string) {
    setAvatarId(id);
    setPendingOverrides({});
  }

  // This creator's own photo-generated avatars (Phase 6,
  // backend/src/avatar_gen/) -- loaded once per dialog open and rendered as
  // extra gallery cards alongside AVATAR_LIBRARY's seed characters below.
  // Kept as plain summaries (id/name/thumbnail), not full AvatarLibraryEntry
  // triples: AvatarThumbnailCanvas/AvatarPreviewCanvas already resolve any
  // avatarId (seed or generated) through the same getCompiledAvatar, so this
  // dialog never needs the full Skin/Design payload itself.
  const [myAvatars, setMyAvatars] = useState<GeneratedAvatarSummary[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    listMyGeneratedAvatars()
      .then((avatars) => {
        if (!cancelled) setMyAvatars(avatars);
      })
      .catch((err) => console.error("Failed to load your generated avatars", err));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handlePhotoPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again later
    if (!file || isGenerating) return;
    setIsGenerating(true);
    setGenerateError(null);
    try {
      const { entry, faceDetected } = await generateAvatarFromPhoto(file);
      setMyAvatars((prev) => [
        { id: entry.design.designId, name: entry.design.meta.name, thumbnailUrl: null, createdAt: new Date().toISOString() },
        ...prev,
      ]);
      selectAvatar(entry.design.designId);
      if (!faceDetected) {
        setGenerateError("Couldn't detect a face in that photo, so this uses a default look instead of your photo. Try a clearer, front-facing, well-lit photo.");
      }
    } catch (err) {
      if (err instanceof FeatureLockedError) setLockedError(err);
      else setGenerateError(err instanceof Error ? err.message : "Couldn't generate an avatar from that photo");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleDeleteGenerated(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await deleteGeneratedAvatar(id);
      setMyAvatars((prev) => prev.filter((a) => a.id !== id));
      if (avatarId === id) selectAvatar(AVATAR_LIBRARY[0]?.design.designId ?? "");
    } catch (err) {
      console.error("Failed to delete generated avatar", err);
    }
  }

  // In-place rename (InlineEditableText on the "My avatars" gallery card) --
  // optimistic, same "update local state first, revert on a caught error"
  // posture as /library's own handleUpdateMetadata, since a failed PATCH
  // here is rare and not worth a per-card loading state.
  async function handleRenameGenerated(id: string, name: string) {
    const previous = myAvatars.find((a) => a.id === id)?.name;
    setMyAvatars((prev) => prev.map((a) => (a.id === id ? { ...a, name } : a)));
    try {
      await renameGeneratedAvatar(id, name);
    } catch (err) {
      console.error("Failed to rename generated avatar", err);
      if (previous !== undefined) setMyAvatars((prev) => prev.map((a) => (a.id === id ? { ...a, name: previous } : a)));
    }
  }

  // Phase 7 -- the raw topology/skin (NOT the compiled form) for whichever
  // avatar is picked RIGHT NOW: "Edit with AI" needs the actual
  // boneGroups/colorSlots/anchors/expressionParams ids to (a) tell the
  // backend what this specific avatar can and can't be edited on, and (b)
  // re-validate/clamp whatever ops it returns (edits.ts's
  // applyAvatarEditOps). A seed avatar resolves synchronously
  // (getAvatarLibraryEntry); a Phase-6 generated one needs one fetch --
  // `cancelled` guards the same "a different avatar was picked before this
  // resolved" race every other async effect in this file already guards.
  const [resolvedEntry, setResolvedEntry] = useState<{ topology: AvatarTopology; skin: AvatarSkin } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResolvedEntry(null);
    const seedEntry = getAvatarLibraryEntry(avatarId);
    if (seedEntry) {
      setResolvedEntry({ topology: seedEntry.topology, skin: seedEntry.skin });
      return;
    }
    if (!avatarId) return;
    fetchGeneratedAvatarEntry(avatarId)
      .then((entry) => {
        if (!cancelled && entry) setResolvedEntry({ topology: entry.topology, skin: entry.skin });
      })
      .catch((err) => console.error("Failed to resolve avatar topology/skin for avatarId=%s", avatarId, err));
    return () => {
      cancelled = true;
    };
  }, [avatarId]);

  // The action ids pickable for whichever avatar is picked RIGHT NOW --
  // recomputed every render off avatarId (a plain Object.keys lookup, cheap
  // enough that memoizing it would just be ceremony).
  const actionOptions = actionIdsForAvatar(avatarId);

  // Phase 8 ("selectable torsos") -- "Shirt" (garmentId `undefined`, the
  // base "torso" rect) is always first and always offered, even before
  // resolvedEntry has resolved; the real shapeIds come from THIS avatar's
  // own skin.garmentShapes (same "derive from what this avatar actually
  // supports" principle as actionOptions above), so a foreign/older skin
  // with none just offers Shirt alone rather than a swap that would silently
  // no-op at compile time.
  const garmentOptions: { id: string | undefined; label: string }[] = [
    { id: undefined, label: "Shirt" },
    ...(resolvedEntry?.skin.garmentShapes ?? []).map((shape) => ({ id: shape.shapeId, label: garmentLabel(shape.shapeId) })),
  ];

  // If the picked action isn't even IN that list -- e.g. the user just
  // switched to a different avatar card whose topology doesn't define
  // whatever action was picked for the previous one -- fall back to "idle"
  // (or this avatar's own first action, on the even-more-defensive chance
  // "idle" itself isn't in its list) rather than leaving a stale selection
  // that doesn't correspond to anything this avatar can actually do.
  useEffect(() => {
    if (actionOptions.includes(defaultAction)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDefaultAction(actionOptions.includes("idle") ? "idle" : (actionOptions[0] ?? "idle"));
  }, [actionOptions, defaultAction]);

  // Only ever false if AVATAR_LIBRARY were somehow empty -- not a real
  // condition today (library.ts always seeds at least one entry), kept as
  // a defensive guard rather than assuming that invariant here too.
  const canSave = avatarId !== "";

  function handleSave() {
    if (!canSave) return;
    onSave(avatarId, defaultAction, rect, hasAnyDesignOverride(pendingOverrides) ? pendingOverrides : undefined, framing);
  }

  // "Direct with AI" (Phase 4) -- the narration this clip's own committed
  // time range overlaps, if any (see findOverlappingTtsOverlay's own doc
  // comment). Only meaningful for an already-added overlay (editingOverlay),
  // same as onDirect itself.
  const overlappingNarration = editingOverlay ? findOverlappingTtsOverlay(ttsOverlays, editingOverlay) : null;

  const [isDirecting, setIsDirecting] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const [directorNote, setDirectorNote] = useState<string | null>(null);
  const [lockedError, setLockedError] = useState<FeatureLockedError | null>(null);
  const { loading: isLoadingPermissions, has: hasFeature } = usePermissions();
  const canDirect = isLoadingPermissions || hasFeature("avatar_direct");

  async function handleDirectWithAi() {
    if (!onDirect || !overlappingNarration || isDirecting) return;
    setIsDirecting(true);
    setDirectError(null);
    try {
      const result = await directAvatarActions(overlappingNarration.text, overlappingNarration.durationSeconds, actionOptions);
      onDirect(result.actionTimeline);
      setDirectorNote(result.directorNote);
    } catch (err) {
      if (err instanceof FeatureLockedError) setLockedError(err);
      else setDirectError(err instanceof Error ? err.message : "Failed to direct this avatar");
    } finally {
      setIsDirecting(false);
    }
  }

  // Phase 7 -- "Edit with AI": a free-text prompt ("make it fatter", "add
  // sunglasses", "make him look more evil") turns into a batch of primitive
  // ops (backend/src/avatar/service.py's edit_avatar_design), applied onto
  // pendingOverrides via edits.ts's applyAvatarEditOps (which re-validates
  // every op against this SPECIFIC avatar's own resolvedEntry) and previewed
  // instantly by the left pane's AvatarPreviewCanvas -- nothing is persisted
  // onto the actual overlay clip until Save.
  const [editPrompt, setEditPrompt] = useState("");
  const [isEditingDesign, setIsEditingDesign] = useState(false);
  const [editDesignError, setEditDesignError] = useState<string | null>(null);
  const canEditDesign = isLoadingPermissions || hasFeature("avatar_edit");

  async function handleApplyEdit() {
    const prompt = editPrompt.trim();
    if (!prompt || !resolvedEntry || isEditingDesign) return;
    setIsEditingDesign(true);
    setEditDesignError(null);
    try {
      const { topology, skin } = resolvedEntry;
      const ops = await editAvatarDesign(prompt, {
        boneGroupIds: Object.keys(topology.boneGroups),
        colorSlotIds: (skin.colorSlots ?? []).map((slot) => slot.slotId),
        // Only the accessories that can actually attach to THIS topology's
        // own anchors -- same "read this avatar's real capability, don't
        // offer a global catalog" principle actionIdsForAvatar/actionOptions
        // above already apply to actions.
        accessories: ACCESSORY_CATALOG.filter((entry) => topology.anchors.some((anchor) => anchor.anchorId === entry.anchorId)).map(
          (entry) => ({ accessoryAssetId: entry.accessoryAssetId, anchorId: entry.anchorId, name: entry.name })
        ),
        expressionParams: Object.fromEntries(
          Object.entries(topology.expressionParams ?? {}).map(([paramId, spec]) => [paramId, { min: spec.min, max: spec.max }])
        ),
      });
      setPendingOverrides((prev) => applyAvatarEditOps(prev, ops, topology, skin));
      setEditPrompt("");
    } catch (err) {
      if (err instanceof FeatureLockedError) setLockedError(err);
      else setEditDesignError(err instanceof Error ? err.message : "Couldn't apply that edit -- try again");
    } finally {
      setIsEditingDesign(false);
    }
  }

  const canResetDesignOverrides = hasAnyDesignOverride(pendingOverrides);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editingOverlay ? "Edit avatar" : "Add avatar"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{editingOverlay ? "Edit avatar" : "Add avatar"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto sm:flex-row">
          {/* Left half: the real frame, with the avatar's own rect draggable
              directly on top of it -- same as TextOverlayDialog. */}
          <div className="flex flex-col gap-1.5 sm:w-1/2">
            <div
              className="relative w-full overflow-hidden rounded-md bg-black"
              style={frameAspectRatio ? { aspectRatio: `${frameAspectRatio}` } : { minHeight: "12rem" }}
            >
              {previewFrameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset
                <img src={previewFrameUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : (
                <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                  No frame preview yet -- add a video first
                </p>
              )}
              <OverlayRectOverlay
                rect={rect}
                onChange={setRect}
                onCommit={setRect}
                borderColorClassName="border-teal-400"
                handleColorClassName="bg-teal-400"
                renderInner={
                  <AvatarPreviewCanvas
                    avatarId={avatarId}
                    action={defaultAction}
                    designOverrides={pendingOverrides}
                    framing={framing}
                    className="h-full w-full"
                  />
                }
              />
            </div>
            <p className="text-[11px] text-muted">Drag to position, drag the corner to resize.</p>

            {/* Phase 7 -- "Edit with AI": a free-text customization prompt,
                applied onto pendingOverrides (previewed instantly above)
                rather than a form full of sliders/color pickers, per this
                product's own bias toward simple direct-manipulation/
                conversational controls over exposing every knob. */}
            <div className="mt-2 flex flex-col gap-1">
              <label htmlFor="avatar-edit-prompt" className="text-xs font-medium text-foreground">
                Customize with AI
              </label>
              <div className="flex gap-1.5">
                <input
                  id="avatar-edit-prompt"
                  type="text"
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleApplyEdit();
                    }
                  }}
                  placeholder="e.g. make it fatter, add sunglasses, more evil"
                  disabled={!resolvedEntry || isEditingDesign}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={handleApplyEdit}
                  disabled={!resolvedEntry || !editPrompt.trim() || isEditingDesign}
                  className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {isEditingDesign ? "Applying…" : "Apply"}
                  {!canEditDesign && <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase">Pro</span>}
                </button>
              </div>
              {editDesignError && <p className="text-[11px] text-red-600">{editDesignError}</p>}
              {canResetDesignOverrides && (
                <button
                  type="button"
                  onClick={() => setPendingOverrides({})}
                  className="self-start text-[11px] text-muted hover:text-foreground hover:underline"
                >
                  Reset customization
                </button>
              )}
            </div>
          </div>

          {/* Right half: character gallery + action grid. */}
          <div className="flex min-h-0 flex-1 flex-col sm:w-1/2">
            <h3 className="mb-1.5 text-xs font-medium text-foreground">Character</h3>
            <div className="mb-3 grid grid-cols-3 gap-2">
              {AVATAR_LIBRARY.map((entry) => (
                <button
                  key={entry.design.designId}
                  type="button"
                  onClick={() => selectAvatar(entry.design.designId)}
                  className={
                    "flex flex-col gap-1 rounded-md border-2 p-1.5 text-xs " +
                    (avatarId === entry.design.designId ? "border-accent bg-accent/10" : "border-border hover:bg-background")
                  }
                >
                  {/* Square, not /library's own tall aspect-[9/16] video-card
                      pattern this originally mirrored -- AvatarThumbnailCanvas
                      now crops to a head-only shot (see its own doc comment),
                      and a roughly-square source region wants a roughly-square
                      box, not a tall one with dead space above/below the face. */}
                  <div className="relative aspect-square w-full overflow-hidden rounded bg-black">
                    <AvatarThumbnailCanvas avatarId={entry.design.designId} className="absolute inset-0 h-full w-full" />
                  </div>
                  <span className="w-full truncate text-center text-foreground">{entry.design.meta.name}</span>
                </button>
              ))}

              {/* A plain `div` card, not a `button` -- unlike the seed
                  Character cards above, this one needs a nested interactive
                  name edit (InlineEditableText) below, and a `button` can't
                  legally contain another one. Selecting the avatar is now
                  the thumbnail's own click target instead of the whole
                  card's. */}
              {myAvatars.map((summary) => (
                <div
                  key={summary.id}
                  className={
                    "flex flex-col gap-1 rounded-md border-2 p-1.5 text-xs " +
                    (avatarId === summary.id ? "border-accent bg-accent/10" : "border-border hover:bg-background")
                  }
                >
                  <button
                    type="button"
                    onClick={() => selectAvatar(summary.id)}
                    aria-label={`Select ${summary.name}`}
                    className="relative aspect-square w-full overflow-hidden rounded bg-black"
                  >
                    <AvatarThumbnailCanvas avatarId={summary.id} className="absolute inset-0 h-full w-full" />
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => handleDeleteGenerated(summary.id, e)}
                      aria-label="Delete this avatar"
                      className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[10px] text-white"
                    >
                      ✕
                    </span>
                  </button>
                  <InlineEditableText
                    value={summary.name}
                    onCommit={(name) => handleRenameGenerated(summary.id, name)}
                    ariaLabel="Avatar name"
                    className="w-full truncate text-center text-foreground"
                    inputClassName="block w-full truncate rounded border border-border bg-background px-1 text-center text-foreground outline-none"
                  />
                </div>
              ))}

              {/* "Sophisticated faces" (Phase 6) -- generate a new character
                  from a photo, deterministic landmark -> template mapping run
                  server-side (backend/src/avatar_gen/). One click opens the
                  OS file picker directly (no separate naming step) per this
                  product's own bias toward sensible defaults over exposing
                  every knob -- the actual gate ("avatar_generate") is
                  enforced server-side, same posture as "Direct with AI"'s
                  own canDirect below (a locked account still gets to try;
                  the resulting 403 surfaces as lockedError). */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isGenerating}
                className="flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-border p-1.5 text-xs text-muted hover:bg-background disabled:opacity-50"
              >
                <div className="flex aspect-square w-full items-center justify-center rounded bg-background text-2xl">
                  {isGenerating ? "…" : "+"}
                </div>
                <span>{isGenerating ? "Generating…" : "From a photo"}</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                onChange={handlePhotoPicked}
              />
            </div>
            {generateError && <p className="-mt-2 mb-3 text-[11px] text-red-600">{generateError}</p>}

            <h3 className="mb-1.5 text-xs font-medium text-foreground">Action</h3>
            <div className="mb-3 grid grid-cols-2 gap-1.5">
              {actionOptions.map((actionId) => (
                <button
                  key={actionId}
                  type="button"
                  onClick={() => setDefaultAction(actionId)}
                  className={
                    "rounded-md border py-1.5 text-xs font-medium " +
                    (defaultAction === actionId
                      ? "border-accent bg-accent text-accent-foreground"
                      : "border-border text-foreground hover:bg-background")
                  }
                >
                  {actionLabel(actionId)}
                </button>
              ))}
            </div>

            {/* Phase 8 -- "Portrait mode": crops the legs so just
                hands+torso+head fill the rect, like a seated close-up shot.
                A plain two-way toggle (not a dropdown/checkbox) per this
                product's own bias toward simple, obvious direct-manipulation
                controls over form-y widgets. */}
            <h3 className="mb-1.5 text-xs font-medium text-foreground">Framing</h3>
            <div className="mb-3 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setFraming("full")}
                className={
                  "rounded-md border py-1.5 text-xs font-medium " +
                  (framing === "full" ? "border-accent bg-accent text-accent-foreground" : "border-border text-foreground hover:bg-background")
                }
              >
                Full body
              </button>
              <button
                type="button"
                onClick={() => setFraming("bust")}
                title="Hands and torso only, legs cropped out"
                className={
                  "rounded-md border py-1.5 text-xs font-medium " +
                  (framing === "bust" ? "border-accent bg-accent text-accent-foreground" : "border-border text-foreground hover:bg-background")
                }
              >
                Portrait
              </button>
            </div>

            {/* Phase 8 -- "Outfit": swaps the torso's own silhouette
                (shirt/polo/suit/blazer, avatar/skin.ts's
                AvatarSkinGarmentShape) via `pendingOverrides.garmentId` --
                the SAME per-clip override object "Customize with AI"/
                "Reset customization" already manage, so this composes with
                that flow (and with the shirtColor slot, which keeps
                recoloring whichever outfit is picked) for free. */}
            <h3 className="mb-1.5 text-xs font-medium text-foreground">Outfit</h3>
            <div className="mb-3 grid grid-cols-2 gap-1.5">
              {garmentOptions.map((option) => {
                const isActive = (pendingOverrides.garmentId ?? undefined) === option.id;
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => setPendingOverrides((prev) => ({ ...prev, garmentId: option.id }))}
                    className={
                      "rounded-md border py-1.5 text-xs font-medium " +
                      (isActive ? "border-accent bg-accent text-accent-foreground" : "border-border text-foreground hover:bg-background")
                    }
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            {editingOverlay && onDirect && (
              <div className="mb-3">
                <button
                  type="button"
                  onClick={handleDirectWithAi}
                  disabled={!overlappingNarration || isDirecting}
                  title={!overlappingNarration ? "Add a narration overlay overlapping this avatar first" : undefined}
                  className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {isDirecting ? "Directing…" : "Direct with AI"}
                  {!canDirect && (
                    <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase">Pro</span>
                  )}
                </button>
                {directError && <p className="mt-1 text-[11px] text-red-600">{directError}</p>}
                {directorNote && !directError && (
                  <p className="mt-1 text-[11px] italic text-muted">&ldquo;{directorNote}&rdquo;</p>
                )}
              </div>
            )}

            <div className="mt-auto flex items-center gap-2">
              {editingOverlay && onDelete && (
                <button type="button" onClick={onDelete} className="text-xs text-red-600 hover:underline">
                  Remove avatar
                </button>
              )}
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-border py-1.5 px-3 text-sm font-medium text-foreground hover:bg-background"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!canSave}
                  className="rounded-md bg-accent py-1.5 px-3 text-sm font-medium text-accent-foreground disabled:opacity-50"
                >
                  {editingOverlay ? "Save" : "Add"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {lockedError && <UpgradeRequiredDialog error={lockedError} onClose={() => setLockedError(null)} />}
    </div>
  );
}
