"use client";

/** Bare /dashboard has nothing of its own to show now that project
 * switching lives inside the editor page -- it just resumes wherever the
 * user last was (see lib/lastProject.ts), falling back to their most
 * recent reel, or to reel creation if they have none yet. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listProjects } from "@/lib/projects";
import { getLastProjectId } from "@/lib/lastProject";

export default function DashboardPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then((projects) => {
        const lastProjectId = getLastProjectId();
        const target = projects.find((project) => project.id === lastProjectId) ?? projects[0];
        router.replace(target ? `/dashboard/${target.id}` : "/dashboard/new");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your reels"));
  }, [router]);

  if (error) {
    return <p className="p-6 text-sm text-red-600">Couldn&apos;t load your reels: {error}</p>;
  }
  return <p className="p-6 text-sm text-muted">Loading…</p>;
}
