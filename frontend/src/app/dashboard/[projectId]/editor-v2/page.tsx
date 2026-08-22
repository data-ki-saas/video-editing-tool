"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { getProject, type Project } from "@/lib/projects";
import { ThreePaneEditor } from "@/components/editor-v2/ThreePaneEditor";

/** New client-side editor, built up in baby steps -- lives alongside the
 * existing Creatomate-based editor at /dashboard/[projectId] rather than
 * replacing it, until it's solid enough to swap in. */
export default function EditorV2Page({ params }: { params: Promise<{ projectId: string }> }) {
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <h1 className="text-sm font-semibold">{project.name} (new editor -- work in progress)</h1>
        <Link href={`/dashboard/${project.id}`} className="text-sm text-muted hover:underline">
          Back to current editor
        </Link>
      </div>
      <div className="min-h-0 flex-1">
        <ThreePaneEditor projectId={project.id} />
      </div>
    </div>
  );
}
