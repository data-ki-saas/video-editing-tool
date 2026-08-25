"use client";

/**
 * Bottom band of the three-pane editor. Left: a live summary of every
 * transformation currently ACTIVE on the clip -- the clip rectangle, each
 * zoom/pan transition, and every flip/mirror window -- not a log of every
 * click that got it there. Undo/redo (Ctrl+Z/Ctrl+Y, see
 * ThreePaneEditor.tsx) still walks that click-by-click history underneath
 * (lib/useEditHistory.ts); this panel just doesn't surface the history
 * itself, only what it currently adds up to. Middle: status/errors from the
 * asset list and the thumbnail/volume analysis pipeline, plus render
 * status once a render has been started. Right: a vertical strip -- a
 * bright-green cloud Render button and a lighter-green "Edge Render" button
 * (the free/local render, see lib/localRender/exportTimeline.ts) stacked at the top,
 * settings/sign-out anchored to the bottom (moved here from the
 * dashboard's old persistent top bar, see app/dashboard/layout.tsx, to
 * give the editor that row of height back).
 */
import Link from "next/link";
import { CLIP_RECT_OPTIONS } from "./ClipRectIcon";
import { RenderIcon, LocalRenderIcon } from "./icons/PlayerIcons";
import { TRANSCRIPT_CAPTION_TEMPLATE_OPTIONS } from "@/lib/video/transcriptCaptionTemplates";
import { computeFlipSegments } from "@/lib/video/video_math";
import { SignOutButton } from "@/components/SignOutButton";
import { SettingsIcon } from "@/components/icons/UIIcons";
import type { EditSelectionsSnapshot } from "@/lib/projects";

function formatTimeRange(startTimeSeconds: number, endTimeSeconds: number): string {
  const format = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const wholeSeconds = Math.floor(seconds % 60);
    return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}`;
  };
  return `${format(startTimeSeconds)}–${format(endTimeSeconds)}`;
}

function ActiveTransformationsList({
  selections,
  videoDurationSeconds,
}: {
  selections: EditSelectionsSnapshot;
  videoDurationSeconds: number;
}) {
  const rows: string[] = [];

  if (selections.clipRectId) {
    const option = CLIP_RECT_OPTIONS.find((candidate) => candidate.id === selections.clipRectId);
    rows.push(`Clip rectangle: ${option?.ratioLabel ?? selections.clipRectId}`);
  }
  for (const effect of selections.zoomEffects) {
    rows.push(`Zoom/pan ${formatTimeRange(effect.startTimeSeconds, effect.endTimeSeconds)}`);
  }
  for (const segment of computeFlipSegments(selections.flipHorizontalToggles, videoDurationSeconds)) {
    rows.push(`Flipped ${formatTimeRange(segment.startTimeSeconds, segment.endTimeSeconds)}`);
  }
  for (const segment of computeFlipSegments(selections.flipVerticalToggles, videoDurationSeconds)) {
    rows.push(`Mirrored ${formatTimeRange(segment.startTimeSeconds, segment.endTimeSeconds)}`);
  }
  for (const range of selections.trimRanges) {
    rows.push(`Trimmed ${formatTimeRange(range.startTimeSeconds, range.endTimeSeconds)}`);
  }
  for (const overlay of selections.overlayImages) {
    rows.push(`Image overlay ${formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}`);
  }
  for (const overlay of selections.textOverlays) {
    rows.push(`Text "${overlay.text}" ${formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}`);
  }
  for (const overlay of selections.videoOverlays) {
    const layoutLabel =
      overlay.layout.type === "full-screen"
        ? "Full-Screen"
        : overlay.layout.type === "picture-in-picture"
          ? "Picture-in-Picture"
          : "Split Screen";
    rows.push(`Overlay (${layoutLabel}) ${formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}`);
  }
  if (selections.sequenceClips.length > 1) {
    rows.push(`Sequence: ${selections.sequenceClips.length} clips`);
  }
  if (selections.transcriptCaption) {
    const option = TRANSCRIPT_CAPTION_TEMPLATE_OPTIONS.find(
      (candidate) => candidate.id === selections.transcriptCaption?.templateId
    );
    rows.push(`Auto-captions: ${option?.name ?? selections.transcriptCaption.templateId}`);
  }

  if (rows.length === 0) {
    return <p className="text-xs text-muted">No transformations applied yet.</p>;
  }

  return (
    <ul className="flex h-full flex-col gap-0.5 overflow-y-auto">
      {rows.map((row, index) => (
        <li key={index} className="truncate rounded-md px-2 py-0.5 text-xs text-foreground">
          {row}
        </li>
      ))}
    </ul>
  );
}

const TERMINAL_RENDER_STATUSES = new Set(["completed", "failed"]);

function RenderStatusMessage({
  isRendering,
  renderStatus,
  renderUrl,
  renderError,
  isRenderStuck,
}: {
  isRendering: boolean;
  renderStatus: string | null;
  renderUrl: string | null;
  renderError: string | null;
  isRenderStuck: boolean;
}) {
  if (isRendering) return <p className="text-muted">Starting render…</p>;
  if (renderStatus === "failed") {
    return <p className="text-red-600">Render failed{renderError ? `: ${renderError}` : ""}</p>;
  }
  if (renderStatus === "completed" && renderUrl) {
    return (
      <p className="text-foreground">
        Render ready —{" "}
        <a href={renderUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          watch or download
        </a>
      </p>
    );
  }
  if (renderStatus && !TERMINAL_RENDER_STATUSES.has(renderStatus)) {
    return (
      <p className="text-muted">
        Rendering… {isRenderStuck && "this is taking longer than usual"}
      </p>
    );
  }
  return null;
}

export function FeedbackArea({
  assetsError,
  analysisError,
  saveError,
  isAnalyzing,
  isUploading,
  selections,
  videoDurationSeconds,
  canRender,
  isRendering,
  renderStatus,
  renderUrl,
  renderError,
  isRenderStuck,
  onRenderClick,
  canLocalRender,
  isLocalRendering,
  isLocalRenderSupported,
  localRenderUnsupportedReason,
  onLocalRenderClick,
}: {
  assetsError: string | null;
  analysisError: string | null;
  saveError: string | null;
  isAnalyzing: boolean;
  isUploading: boolean;
  selections: EditSelectionsSnapshot;
  videoDurationSeconds: number;
  canRender: boolean;
  isRendering: boolean;
  renderStatus: string | null;
  renderUrl: string | null;
  renderError: string | null;
  isRenderStuck: boolean;
  onRenderClick: () => void;
  canLocalRender: boolean;
  isLocalRendering: boolean;
  isLocalRenderSupported: boolean;
  localRenderUnsupportedReason: string | null;
  onLocalRenderClick: () => void;
}) {
  const hasRenderMessage = isRendering || renderStatus !== null;
  const hasMessages = assetsError || analysisError || saveError || isAnalyzing || isUploading || hasRenderMessage;
  const renderDisabled = !canRender || isRendering || (renderStatus !== null && !TERMINAL_RENDER_STATUSES.has(renderStatus));

  // lib/localRender/exportTimeline.ts still has no knowledge of Creatomate's
  // server-side speech transcription -- transcript captions stay gated on
  // the cloud Render button until/unless a client-side transcription path
  // exists. Video overlays, by contrast, are fully composited locally now
  // (see that file's own module comment), so they're no longer gated here.
  const hasTranscriptCaption = Boolean(selections.transcriptCaption);
  const localRenderDisabled = !canLocalRender || isLocalRendering || hasTranscriptCaption || !isLocalRenderSupported;
  const localRenderTitle = !canLocalRender
    ? "Add a video before rendering"
    : hasTranscriptCaption
      ? "Edge Render doesn't support auto-captions yet — use Render instead"
      : !isLocalRenderSupported
        ? (localRenderUnsupportedReason ?? "Edge Render needs a Chromium browser (Chrome or Microsoft Edge)")
        : "Edge Render (in your browser, no cost)";

  return (
    <div className="flex h-full gap-4 px-4 py-2 text-sm">
      <div className="w-64 shrink-0 overflow-hidden border-r border-border pr-4">
        <ActiveTransformationsList selections={selections} videoDurationSeconds={videoDurationSeconds} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        {!hasMessages && <p className="text-muted">No issues to report.</p>}
        {assetsError && <p className="text-red-600">Couldn&apos;t load your videos: {assetsError}</p>}
        {analysisError && <p className="text-red-600">Couldn&apos;t analyze this video: {analysisError}</p>}
        {saveError && <p className="text-red-600">Couldn&apos;t save your changes: {saveError}</p>}
        {isUploading && <p className="text-muted">Uploading…</p>}
        {isAnalyzing && !analysisError && <p className="text-muted">Analyzing video for the timeline preview…</p>}
        <RenderStatusMessage
          isRendering={isRendering}
          renderStatus={renderStatus}
          renderUrl={renderUrl}
          renderError={renderError}
          isRenderStuck={isRenderStuck}
        />
      </div>

      <div className="flex h-full shrink-0 flex-col items-center justify-between border-l border-border pl-3">
        <div className="flex flex-col items-center gap-2">
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

        <div className="flex flex-col items-center gap-1">
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
    </div>
  );
}
