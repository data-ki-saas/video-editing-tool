"use client";

import { useEffect, useState } from "react";
import { triggerRender } from "@/lib/api";
import { getProject, type Timeline } from "@/lib/projects";

const RENDER_POLL_INTERVAL_MS = 5000;
const TERMINAL_RENDER_STATUSES = new Set(["completed", "failed"]);

/** Shared render lifecycle: trigger, then poll while in flight. Used by both
 * the desktop editor (VideoEditor.tsx) and the mobile quick-create flow
 * (QuickCreate.tsx) so the two don't drift on this logic independently.
 * Callers own their own initial project load (each needs the full project
 * for other reasons -- the timeline, or the niche/attributes) and call
 * `applyProjectStatus()` once it resolves, rather than this hook doing a
 * redundant fetch of its own. */
export function useRenderStatus(projectId: string) {
  const [isRendering, setIsRendering] = useState(false);
  const [renderStatus, setRenderStatus] = useState<string | null>(null);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!renderStatus || TERMINAL_RENDER_STATUSES.has(renderStatus)) return;

    const interval = setInterval(() => {
      getProject(projectId)
        .then((project) => {
          setRenderStatus(project.render_status);
          setRenderUrl(project.render_url);
        })
        .catch(() => {
          // A transient poll failure isn't worth surfacing -- the next tick retries.
        });
    }, RENDER_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [projectId, renderStatus]);

  function applyProjectStatus(project: { render_status: string | null; render_url: string | null }) {
    setRenderStatus(project.render_status);
    setRenderUrl(project.render_url);
  }

  async function startRender(timeline: Timeline) {
    setIsRendering(true);
    setRenderError(null);
    try {
      const result = await triggerRender(projectId, timeline);
      setRenderStatus(result.status);
      if (result.warning) setRenderError(result.warning);
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : "Failed to start render");
    } finally {
      setIsRendering(false);
    }
  }

  return {
    isRendering,
    renderStatus,
    renderUrl,
    renderError,
    isTerminal: renderStatus !== null && TERMINAL_RENDER_STATUSES.has(renderStatus),
    applyProjectStatus,
    startRender,
  };
}
