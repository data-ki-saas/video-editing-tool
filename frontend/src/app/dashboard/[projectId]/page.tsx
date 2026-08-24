"use client";

import { use, useEffect, useState } from "react";
import { getProject, type Project } from "@/lib/projects";
import { setLastProjectId } from "@/lib/lastProject";
import { ThreePaneEditor } from "@/components/editor-v2/ThreePaneEditor";
import { ReelLoader } from "@/components/ReelLoader";

// No header strip here -- the active reel's name is already shown
// (highlighted, inline-editable) in ProjectList inside the Action Area, so
// a second copy up here was just duplicating it and eating a full-width
// row of vertical space the editor could use instead.
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
    return <ReelLoader stage="Loading your reel…" className="h-full p-6" />;
  }

  return (
    <ThreePaneEditor
      key={project.id}
      projectId={project.id}
      initialTimeline={project.timeline}
      initialProject={project}
    />
  );
}
