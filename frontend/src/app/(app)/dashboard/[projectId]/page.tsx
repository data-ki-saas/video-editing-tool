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
  // Bumped by the error screen's "Retry" button to force the load effect
  // below to re-run even though projectId hasn't changed -- the shared
  // Supabase fetch wrapper already retries a transient network failure once
  // on its own (see lib/supabase/client.ts), but a longer outage or a
  // Supabase project waking up from a free-tier pause can outlast that, and
  // shouldn't strand the user on a dead-end error page with no way back in
  // short of a full reload.
  const [retryToken, setRetryToken] = useState(0);
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
  }, [projectId, router, retryToken]);

  if (error) {
    return (
      <div className="flex flex-col items-start gap-3 p-6 text-sm text-red-600">
        <p>Couldn&apos;t load this reel: {error}</p>
        <button
          type="button"
          onClick={() => setRetryToken((n) => n + 1)}
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
