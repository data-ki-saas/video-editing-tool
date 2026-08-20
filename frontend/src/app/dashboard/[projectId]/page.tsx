"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { getProject, type Project } from "@/lib/projects";
import { VideoEditor } from "@/components/VideoEditor";

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
      .then(setProject)
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
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <div>
          <Link href="/dashboard" className="text-sm text-neutral-500 hover:underline">
            ← Your reels
          </Link>
          <h1 className="text-lg font-semibold">{project.name}</h1>
          {details && <p className="text-sm text-neutral-500">{details}</p>}
        </div>
      </div>
      <VideoEditor key={project.id} projectId={project.id} />
    </div>
  );
}
