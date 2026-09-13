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
 * spec.
 */
import { useEffect, useRef, useState } from "react";
import { OverlayRectOverlay } from "./OverlayRectOverlay";
import { UpgradeRequiredDialog } from "@/components/UpgradeRequiredDialog";
import { getCompiledAvatar, type CompiledAvatar } from "@/lib/video/avatar/compile";
import { computeAvatarPose, computeMouthShapeId } from "@/lib/video/avatar/actions";
import { drawAvatar } from "@/lib/video/avatar/renderer";
import { AVATAR_LIBRARY, getAvatarLibraryEntry } from "@/lib/video/avatar/library";
import type { AvatarActionId } from "@/lib/video/avatar/topology";
import { ambientEffectSeed } from "@/lib/video/ambientEffects";
import {
  DEFAULT_AVATAR_OVERLAY_RECT,
  findOverlappingTtsOverlay,
  type AvatarAction,
  type AvatarOverlayClip,
  type CropRect,
  type TtsOverlay,
} from "@/lib/video/video_math";
import { directAvatarActions, FeatureLockedError } from "@/lib/api";
import { usePermissions } from "@/lib/usePermissions";

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

// The actual pickable action ids for whichever avatar is CURRENTLY
// selected -- derived from that avatar's own resolved topology (Object.keys
// of its `actions` map, which preserves the insertion order library.ts
// authored it in: baseline six first, extras after) rather than a fixed
// array, so a richer topology's extra actions show up here with no further
// change to this component. Falls back to the baseline six only if the
// lookup itself fails (see BASELINE_ACTION_IDS's own comment).
function actionIdsForAvatar(avatarId: string): string[] {
  const actionIds = Object.keys(getAvatarLibraryEntry(avatarId)?.topology.actions ?? {});
  return actionIds.length > 0 ? actionIds : BASELINE_ACTION_IDS;
}

/**
 * One static rendered frame per gallery card -- reuses the exact
 * compile/pose/draw pipeline AvatarPreviewCanvas (below) drives for the live
 * left-pane preview, but drawn ONCE (idle, t=0) rather than looped: a whole
 * gallery of simultaneous rAF loops would be needless cost for a picker
 * whose job is "show me which character this is," not "show me it acting" --
 * that live performance is exactly what the left pane is already for. Per
 * AvatarDesign.meta.thumbnail's own "unused this phase" doc comment
 * (design.ts), there's still no static image asset per skin -- this renders
 * a real frame off the same live rig instead of waiting on one.
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
        canvas.width = width;
        canvas.height = height;
        const pose = computeAvatarPose(compiled.topology, "idle", 0, ambientEffectSeed(avatarId));
        const mouthShapeId = computeMouthShapeId("idle", 0);
        drawAvatar(ctx, compiled, pose, { x: 0, y: 0, width, height }, mouthShapeId);
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
function AvatarPreviewCanvas({ avatarId, action, className }: { avatarId: string; action: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compiledRef = useRef<CompiledAvatar | null>(null);
  const seedRef = useRef(0);

  // (Re)compiles whenever the picked avatarId changes. `cancelled` guards
  // against a stale resolution landing after the user has since picked a
  // DIFFERENT avatar (or this dialog has since closed/unmounted) --
  // compiledRef is simply never written in that case, so the loop below
  // keeps drawing whatever it already had (or nothing, if this is the
  // first pick) instead of a wrong, late-arriving character.
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
    getCompiledAvatar(avatarId)
      .then((compiled) => {
        if (!cancelled) compiledRef.current = compiled;
      })
      .catch((err) => {
        console.error("Avatar preview compile failed for avatarId=%s", avatarId, err);
      });
    return () => {
      cancelled = true;
    };
  }, [avatarId]);

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
          const pose = computeAvatarPose(compiled.topology, action, elapsedSeconds, seedRef.current);
          const mouthShapeId = computeMouthShapeId(action, elapsedSeconds);
          drawAvatar(ctx, compiled, pose, { x: 0, y: 0, width: canvas.width, height: canvas.height }, mouthShapeId);
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
  onSave: (avatarId: string, defaultAction: AvatarActionId | (string & {}), rect: CropRect) => void;
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

  // Re-syncs if a different overlay is opened for editing (or the dialog is
  // reopened fresh for "Add") while already mounted -- same convention as
  // TextOverlayDialog/TtsOverlayDialog's own re-sync effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAvatarId(editingOverlay?.avatarId ?? AVATAR_LIBRARY[0]?.design.designId ?? "");
    setDefaultAction(editingOverlay?.defaultAction ?? "idle");
    setRect(editingOverlay?.rect ?? DEFAULT_AVATAR_OVERLAY_RECT);
  }, [editingOverlay]);

  // The action ids pickable for whichever avatar is picked RIGHT NOW --
  // recomputed every render off avatarId (a plain Object.keys lookup, cheap
  // enough that memoizing it would just be ceremony).
  const actionOptions = actionIdsForAvatar(avatarId);

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
    onSave(avatarId, defaultAction, rect);
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
                renderInner={<AvatarPreviewCanvas avatarId={avatarId} action={defaultAction} className="h-full w-full" />}
              />
            </div>
            <p className="text-[11px] text-muted">Drag to position, drag the corner to resize.</p>
          </div>

          {/* Right half: character gallery + action grid. */}
          <div className="flex min-h-0 flex-1 flex-col sm:w-1/2">
            <h3 className="mb-1.5 text-xs font-medium text-foreground">Character</h3>
            <div className="mb-3 grid grid-cols-3 gap-2">
              {AVATAR_LIBRARY.map((entry) => (
                <button
                  key={entry.design.designId}
                  type="button"
                  onClick={() => setAvatarId(entry.design.designId)}
                  className={
                    "flex flex-col gap-1 rounded-md border-2 p-1.5 text-xs " +
                    (avatarId === entry.design.designId ? "border-accent bg-accent/10" : "border-border hover:bg-background")
                  }
                >
                  {/* Media box mirrors /library's own card pattern (aspect-[9/16],
                      black background, rounded) -- see this component's own
                      AvatarThumbnailCanvas doc comment for why it's one static
                      frame rather than a per-card animation loop. */}
                  <div className="relative aspect-[9/16] w-full overflow-hidden rounded bg-black">
                    <AvatarThumbnailCanvas avatarId={entry.design.designId} className="absolute inset-0 h-full w-full" />
                  </div>
                  <span className="w-full truncate text-center text-foreground">{entry.design.meta.name}</span>
                </button>
              ))}
            </div>

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
