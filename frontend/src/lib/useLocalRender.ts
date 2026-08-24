"use client";

/**
 * Local counterpart to useRenderStatus.ts -- shaped similarly on purpose
 * (isRendering/resultUrl/resultError mirror isRendering/renderUrl/
 * renderError) so FeedbackArea's two render buttons read as siblings, but
 * there's no polling here: exportVideoLocally runs entirely in this tab and
 * resolves with the finished Blob directly, so there's no render_status
 * column, no webhook, and nothing to poll.
 */
import { useEffect, useState } from "react";
import { exportVideoLocally, type LocalRenderInput } from "@/lib/localRender/exportTimeline";
import { checkLocalRenderSupport } from "@/lib/localRender/isLocalRenderSupported";

export function useLocalRender() {
  const [isSupported, setIsSupported] = useState(true);
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultMimeType, setResultMimeType] = useState<string | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [resultWarnings, setResultWarnings] = useState<string[]>([]);

  useEffect(() => {
    checkLocalRenderSupport().then(({ supported, reason }) => {
      setIsSupported(supported);
      setUnsupportedReason(reason ?? null);
    });
  }, []);

  async function startLocalRender(input: LocalRenderInput) {
    setIsRendering(true);
    setResultError(null);
    setResultWarnings([]);
    setProgress(0);
    // A previous render's blob URL is no longer reachable from the UI once
    // a new one starts -- release it now rather than leaking it for the
    // rest of the tab's lifetime.
    setResultUrl((previousUrl) => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      return null;
    });

    try {
      const { blob, mimeType, warnings } = await exportVideoLocally(input, ({ framesDone, totalFrames }) => {
        setProgress(totalFrames > 0 ? framesDone / totalFrames : 0);
      });
      setResultUrl(URL.createObjectURL(blob));
      setResultMimeType(mimeType);
      setResultWarnings(warnings);
    } catch (err) {
      setResultError(err instanceof Error ? err.message : "Failed to render locally");
    } finally {
      setIsRendering(false);
    }
  }

  return {
    isSupported,
    unsupportedReason,
    isRendering,
    progress,
    resultUrl,
    resultMimeType,
    resultError,
    resultWarnings,
    startLocalRender,
  };
}
