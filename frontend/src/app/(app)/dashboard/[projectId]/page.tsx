"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getProject, ProjectNotFoundError, type Project } from "@/lib/projects";
import { getLastProjectId, setLastProjectId, clearLastProjectId } from "@/lib/lastProject";
import { ThreePaneEditor } from "@/components/editor-v2/ThreePaneEditor";
import { MobileEditor } from "@/components/editor-mobile/MobileEditor";
import { useIsMobile } from "@/lib/useIsMobile";
import { ReelLoader } from "@/components/ReelLoader";

// No header strip here -- the active reel's name is already shown
// (highlighted, inline-editable) in ProjectList inside the Action Area, so
// a second copy up here was just duplicating it and eating a full-width
// row of vertical space the editor could use instead.
export default function ReelEditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  // isReady stays false until the first client-side device check has
  // actually run (matchMedia can't be read during SSR/first paint) -- see
  // useIsMobile's own comment. Gated on below alongside `project` so this
  // never flashes the wrong editor for a phone/desktop viewport.
  const { isMobile, isReady: isMobileCheckReady } = useIsMobile();

  useEffect(() => {
    setError(null);
    getProject(projectId)
      .then((loaded) => {
        setProject(loaded);
        // Marks this as the reel to resume into next time bare /dashboard
        // is opened -- see lib/lastProject.ts.
        setLastProjectId(loaded.id);
      })
      .catch((err) => {
        if (err instanceof ProjectNotFoundError) {
          // This reel is gone (deleted from another tab/device, a stale
          // bookmark, or a dead back-button entry) -- bounce to bare
          // /dashboard instead of getting stuck here. Only clear the cached
          // last-project-id if it's the one that just failed, so a
          // still-valid pointer to some OTHER reel isn't wiped out.
          if (getLastProjectId() === projectId) clearLastProjectId();
          router.replace("/dashboard");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load this reel");
      });
  }, [projectId, router]);

  if (error) {
    return (
      <div className="flex flex-col items-start gap-3 p-6 text-sm text-red-600">
        <p>Couldn&apos;t load this reel: {error}</p>
        <button
          type="button"
          // A full reload, not a re-run of the load effect above -- a stuck
          // load is usually a stale HTTP/3 (QUIC) connection to Supabase's
          // edge (e.g. after the laptop slept, or a VPN/Wi-Fi network
          // change) that the browser keeps reusing and failing on for as
          // long as this tab's network context lives. Re-running the same
          // fetch in-page hits that same broken connection again; only a
          // real navigation makes Chrome establish a fresh one -- confirmed
          // by a plain page refresh succeeding where in-page retry didn't.
          onClick={() => window.location.reload()}
          className="rounded-md border border-red-600 px-3 py-1.5 text-red-600 hover:bg-red-50"
        >
          Retry
        </button>
      </div>
    );
  }
  if (!project || !isMobileCheckReady) {
    return <ReelLoader stage="Loading your reel…" className="h-full p-6" />;
  }

  return isMobile ? (
    <MobileEditor key={project.id} projectId={project.id} initialTimeline={project.timeline} initialProject={project} />
  ) : (
    <ThreePaneEditor
      key={project.id}
      projectId={project.id}
      initialTimeline={project.timeline}
      initialProject={project}
    />
  );
}
