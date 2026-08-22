"use client";

import { use, useEffect, useState } from "react";
import { getProject, type Project } from "@/lib/projects";
import { setLastProjectId } from "@/lib/lastProject";
import { ThreePaneEditor } from "@/components/editor-v2/ThreePaneEditor";

function formatNicheLabel(niche: string | null): string | null {
  if (!niche) return null;
  return niche.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ReelEditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProject(projectId)
      .then((loaded) => {
        setProject(loaded);
        // Marks this as the reel to resume into next time bare /dashboard
        // is opened -- see lib/lastProject.ts.
        setLastProjectId(loaded.id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load this reel"));
  }, [projectId]);

  if (error) {
    return <p className="p-6 text-sm text-red-600">Couldn&apos;t load this reel: {error}</p>;
  }
  if (!project) {
    return <p className="p-6 text-sm text-neutral-500">Loading…</p>;
  }

  const details = [formatNicheLabel(project.niche), ...Object.values(project.attributes).map(String)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold">{project.name}</h1>
          {details && <p className="text-sm text-neutral-500">{details}</p>}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ThreePaneEditor key={project.id} projectId={project.id} />
      </div>
    </div>
  );
}
