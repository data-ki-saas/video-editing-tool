"use client";

import { useEffect, useState } from "react";
import { getOrCreateDefaultProject } from "@/lib/projects";
import { VideoEditor } from "@/components/VideoEditor";

export default function DashboardPage() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getOrCreateDefaultProject()
      .then((project) => setProjectId(project.id))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your project"));
  }, []);

  if (error) {
    return <p className="p-8 text-sm text-red-600">Couldn&apos;t load your project: {error}</p>;
  }
  if (!projectId) {
    return <p className="p-8 text-sm text-neutral-500">Setting up your project…</p>;
  }

  return <VideoEditor projectId={projectId} />;
}
