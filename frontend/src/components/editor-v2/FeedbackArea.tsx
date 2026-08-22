"use client";

/** Bottom band of the three-pane editor: surfaces status/errors from the
 * asset list and the thumbnail/volume analysis pipeline. Kept as a single
 * small component for now (baby step) -- a running message log can replace
 * this once there's more than one thing worth telling the user about. */
export function FeedbackArea({
  assetsError,
  analysisError,
  isAnalyzing,
  isUploading,
}: {
  assetsError: string | null;
  analysisError: string | null;
  isAnalyzing: boolean;
  isUploading: boolean;
}) {
  const hasContent = assetsError || analysisError || isAnalyzing || isUploading;

  return (
    <div className="flex h-full flex-col justify-center gap-1 px-4 py-2 text-sm">
      {!hasContent && <p className="text-muted">No issues to report.</p>}
      {assetsError && <p className="text-red-600">Couldn&apos;t load your videos: {assetsError}</p>}
      {analysisError && <p className="text-red-600">Couldn&apos;t analyze this video: {analysisError}</p>}
      {isUploading && <p className="text-muted">Uploading…</p>}
      {isAnalyzing && !analysisError && <p className="text-muted">Analyzing video for the timeline preview…</p>}
    </div>
  );
}
