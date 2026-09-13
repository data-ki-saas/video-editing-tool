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
 * structural change here -- and a 6-button action grid (AvatarActionId's
 * baseline set, human-readable labels). No free-typed content field at all
 * (unlike TextOverlayDialog's textarea): everything this overlay carries is
 * a pick from a fixed set, per this feature's own spec.
 */
import { useEffect, useRef, useState } from "react";
import { OverlayRectOverlay } from "./OverlayRectOverlay";
import { getCompiledAvatar, type CompiledAvatar } from "@/lib/video/avatar/compile";
import { computeAvatarPose, computeMouthShapeId } from "@/lib/video/avatar/actions";
import { drawAvatar } from "@/lib/video/avatar/renderer";
import { AVATAR_LIBRARY } from "@/lib/video/avatar/library";
import type { AvatarActionId } from "@/lib/video/avatar/topology";
import { ambientEffectSeed } from "@/lib/video/ambientEffects";
import { DEFAULT_AVATAR_OVERLAY_RECT, type AvatarOverlayClip, type CropRect } from "@/lib/video/video_math";

// The baseline action set (topology.ts's AvatarActionId) with the
// human-readable labels this picker shows -- every seed/library Topology is
// expected to define all six (see library.ts's own doc comment), so this
// list doesn't need to be derived per-avatar.
const AVATAR_ACTION_OPTIONS: { id: AvatarActionId; label: string }[] = [
  { id: "idle", label: "Idle" },
  { id: "talk", label: "Talking" },
  { id: "walk", label: "Walking" },
  { id: "sit", label: "Sitting" },
  { id: "sleep", label: "Sleeping" },
  { id: "lookAround", label: "Looking around" },
];

// A plain person silhouette -- this gallery's default "unknown character"
// glyph, shown for every AVATAR_LIBRARY card regardless of its own skin
// (there's no per-avatar static thumbnail image today -- see
// AvatarDesign.meta.thumbnail's own "unused this phase" doc comment in
// design.ts -- the live canvas to the left is this dialog's one and only
// animated preview, per this file's own module comment on why the gallery
// cards themselves stay unanimated).
function AvatarGlyphIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 19.5c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" />
    </svg>
  );
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
function AvatarPreviewCanvas({ avatarId, action, className }: { avatarId: string; action: AvatarActionId; className?: string }) {
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
  onSave,
  onClose,
  onDelete,
}: {
  editingOverlay: AvatarOverlayClip | null;
  previewFrameUrl: string | null;
  frameAspectRatio: number | null;
  onSave: (avatarId: string, defaultAction: AvatarActionId, rect: CropRect) => void;
  onClose: () => void;
  // Only ever passed (and only ever rendered, see the button row below) when
  // editingOverlay is non-null -- a not-yet-added avatar has nothing to
  // delete yet. Same optional, edit-only "Remove" affordance as
  // TextSlideDialog's own onDelete.
  onDelete?: () => void;
}) {
  const [avatarId, setAvatarId] = useState(editingOverlay?.avatarId ?? AVATAR_LIBRARY[0]?.design.designId ?? "");
  const [defaultAction, setDefaultAction] = useState<AvatarActionId>(editingOverlay?.defaultAction ?? "idle");
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

  // Only ever false if AVATAR_LIBRARY were somehow empty -- not a real
  // condition today (library.ts always seeds at least one entry), kept as
  // a defensive guard rather than assuming that invariant here too.
  const canSave = avatarId !== "";

  function handleSave() {
    if (!canSave) return;
    onSave(avatarId, defaultAction, rect);
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
                    "flex flex-col items-center gap-1 rounded-md border-2 p-2 text-xs " +
                    (avatarId === entry.design.designId ? "border-accent bg-accent/10" : "border-border hover:bg-background")
                  }
                >
                  <AvatarGlyphIcon className="h-6 w-6 text-foreground" />
                  <span className="w-full truncate text-center text-foreground">{entry.design.meta.name}</span>
                </button>
              ))}
            </div>

            <h3 className="mb-1.5 text-xs font-medium text-foreground">Action</h3>
            <div className="mb-3 grid grid-cols-2 gap-1.5">
              {AVATAR_ACTION_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setDefaultAction(option.id)}
                  className={
                    "rounded-md border py-1.5 text-xs font-medium " +
                    (defaultAction === option.id
                      ? "border-accent bg-accent text-accent-foreground"
                      : "border-border text-foreground hover:bg-background")
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>

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
    </div>
  );
}
