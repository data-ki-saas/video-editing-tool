"use client";

/** Bare /dashboard has nothing of its own to show now that project
 * switching lives inside the editor page -- it just resumes wherever the
 * user last was (see lib/lastProject.ts). Jumps there immediately if a
 * cached last-project id exists, without waiting on a network round trip
 * first -- the destination page's own error state already handles a
 * since-deleted project gracefully, so there's nothing to validate here
 * that's worth a blank screen for. Falls back to fetching the list only
 * when there's no cached id yet (first-ever visit), and to reel creation
 * if the account has no reels at all. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listProjects } from "@/lib/projects";
import { getLastProjectId } from "@/lib/lastProject";
import { ReelLoader } from "@/components/ReelLoader";

export default function DashboardPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const lastProjectId = getLastProjectId();
    if (lastProjectId) {
      router.replace(`/dashboard/${lastProjectId}`);
      return;
    }

    listProjects()
      .then((projects) => {
        router.replace(projects[0] ? `/dashboard/${projects[0].id}` : "/dashboard/new");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your reels"));
  }, [router]);

  if (error) {
    return <p className="p-6 text-sm text-red-600">Couldn&apos;t load your reels: {error}</p>;
  }
  return <ReelLoader stage="Loading your reels…" className="h-full p-6" />;
}
