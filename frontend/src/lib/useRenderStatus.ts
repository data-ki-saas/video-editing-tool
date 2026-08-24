"use client";

import { useEffect, useState } from "react";
import { triggerRender } from "@/lib/api";
import { getProject } from "@/lib/projects";
import type { CompileTimelineInput } from "@/lib/timeline/compileCreatomateTimeline";

const RENDER_POLL_INTERVAL_MS = 5000;
const TERMINAL_RENDER_STATUSES = new Set(["completed", "failed"]);
// Typical renders finish well under this -- Creatomate encoding a short reel
// takes a couple minutes, and the R2 transfer after that is usually seconds.
// Non-terminal for longer than this is most likely the render-transfer
// worker crashing mid-transfer with nothing left to retry it (a known gap --
// see worker/src/server.js's 202-ack comment), not normal processing time.
// This is a client-side heuristic only, not an authoritative failure --
// render_status might still update moments later.
const RENDER_STUCK_THRESHOLD_MS = 10 * 60 * 1000;

/** Shared render lifecycle: trigger, then poll while in flight. Callers own
 * their own initial project load (they need the full project for other
 * reasons too -- the timeline, or the niche/attributes) and call
 * `applyProjectStatus()` once it resolves, rather than this hook doing a
 * redundant fetch of its own. */
export function useRenderStatus(projectId: string) {
  const [isRendering, setIsRendering] = useState(false);
  const [renderStatus, setRenderStatus] = useState<string | null>(null);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [renderStartedAt, setRenderStartedAt] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  // Bumped on every poll tick (independent of whether the fetched status
  // actually changed) so the "has this been running too long" check below
  // keeps re-evaluating over time instead of freezing at its first value.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!renderStatus || TERMINAL_RENDER_STATUSES.has(renderStatus)) return;

    const interval = setInterval(() => {
      setNow(Date.now());
      getProject(projectId)
        .then((project) => {
          setRenderStatus(project.render_status);
          setRenderUrl(project.render_url);
          setRenderStartedAt(project.render_started_at);
          if (project.render_status === "failed" && project.render_error) {
            setRenderError(project.render_error);
          }
        })
        .catch(() => {
          // A transient poll failure isn't worth surfacing -- the next tick retries.
        });
    }, RENDER_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [projectId, renderStatus]);

  function applyProjectStatus(project: {
    render_status: string | null;
    render_url: string | null;
    render_started_at?: string | null;
    render_error?: string | null;
  }) {
    setRenderStatus(project.render_status);
    setRenderUrl(project.render_url);
    setRenderStartedAt(project.render_started_at ?? null);
    if (project.render_status === "failed" && project.render_error) {
      setRenderError(project.render_error);
    }
  }

  async function startRender(compileInput: CompileTimelineInput) {
    setIsRendering(true);
    setRenderError(null);
    setRenderStartedAt(new Date().toISOString());
    try {
      const result = await triggerRender(projectId, compileInput);
      setRenderStatus(result.status);
      if (result.warning) setRenderError(result.warning);
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : "Failed to start render");
    } finally {
      setIsRendering(false);
    }
  }

  const isTerminal = renderStatus !== null && TERMINAL_RENDER_STATUSES.has(renderStatus);
  const isStuck =
    !isTerminal &&
    renderStatus !== null &&
    renderStartedAt !== null &&
    now - new Date(renderStartedAt).getTime() > RENDER_STUCK_THRESHOLD_MS;

  return {
    isRendering,
    renderStatus,
    renderUrl,
    renderError,
    isStuck,
    isTerminal,
    applyProjectStatus,
    startRender,
  };
}
