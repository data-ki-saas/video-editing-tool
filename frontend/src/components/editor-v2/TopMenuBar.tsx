"use client";

/**
 * Persistent top bar for the reel editor. Left: the two video-generation
 * actions -- the cloud Render button and the local/free Edge Render button
 * (see lib/localRender/exportTimeline.ts) -- kept reachable at all times
 * instead of anchored to the bottom strip. Right: settings/sign-out, same
 * controls the bare /dashboard route shows via its own (chrome) layout.
 */
import Link from "next/link";
import { RenderIcon, LocalRenderIcon } from "./icons/PlayerIcons";
import { SignOutButton } from "@/components/SignOutButton";
import { SettingsIcon } from "@/components/icons/UIIcons";
import type { TranscriptCaption } from "@/lib/video/video_math";

const TERMINAL_RENDER_STATUSES = new Set(["completed", "failed"]);

export function TopMenuBar({
  canRender,
  isRendering,
  renderStatus,
  onRenderClick,
  canLocalRender,
  isLocalRendering,
  isLocalRenderSupported,
  localRenderUnsupportedReason,
  onLocalRenderClick,
  transcriptCaption,
}: {
  canRender: boolean;
  isRendering: boolean;
  renderStatus: string | null;
  onRenderClick: () => void;
  canLocalRender: boolean;
  isLocalRendering: boolean;
  isLocalRenderSupported: boolean;
  localRenderUnsupportedReason: string | null;
  onLocalRenderClick: () => void;
  transcriptCaption: TranscriptCaption | null;
}) {
  const renderDisabled =
    !canRender || isRendering || (renderStatus !== null && !TERMINAL_RENDER_STATUSES.has(renderStatus));

  // lib/localRender/exportTimeline.ts still has no knowledge of Creatomate's
  // server-side speech transcription -- transcript captions stay gated on
  // the cloud Render button until/unless a client-side transcription path
  // exists.
  const hasTranscriptCaption = Boolean(transcriptCaption);
  const localRenderDisabled = !canLocalRender || isLocalRendering || hasTranscriptCaption || !isLocalRenderSupported;
  const localRenderTitle = !canLocalRender
    ? "Add a video before rendering"
    : hasTranscriptCaption
      ? "Edge Render doesn't support auto-captions yet — use Render instead"
      : !isLocalRenderSupported
        ? (localRenderUnsupportedReason ?? "Edge Render needs a Chromium browser (Chrome or Microsoft Edge)")
        : "Edge Render (in your browser, no cost)";

  return (
    <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRenderClick}
          disabled={renderDisabled}
          aria-label="Render"
          title={canRender ? "Render" : "Add a video before rendering"}
          className="rounded-full bg-green-500 p-2 text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RenderIcon className="h-5 w-5" />
        </button>

        <button
          type="button"
          onClick={onLocalRenderClick}
          disabled={localRenderDisabled}
          aria-label="Edge Render"
          title={localRenderTitle}
          className="rounded-full bg-green-300 p-2 text-white hover:bg-green-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <LocalRenderIcon className="h-5 w-5" />
        </button>
      </div>

      <div className="flex items-center gap-1">
        <Link
          href="/settings"
          aria-label="Settings"
          title="Settings"
          className="rounded-full p-2 text-muted hover:bg-foreground/10"
        >
          <SettingsIcon className="h-5 w-5" />
        </Link>
        <SignOutButton />
      </div>
    </div>
  );
}
