"use client";

/**
 * Project switcher, living inside the Action Area (left of the asset
 * gallery) rather than as a persistent full-height sidebar. Replaces that
 * role from the now-removed DashboardSidebar -- "Settings" is kept here too
 * since it had no other home once the sidebar went away.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { listProjects, type Project } from "@/lib/projects";

export function ProjectList({ activeProjectId }: { activeProjectId: string }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your reels"));
  }, []);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Your reels</h2>
        <Link href="/dashboard/new" className="shrink-0 text-xs text-accent hover:underline">
          + New
        </Link>
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {error && <p className="text-xs text-red-600">{error}</p>}
        {!error && !projects && <p className="text-xs text-muted">Loading…</p>}
        {projects?.map((project) => (
          <li key={project.id}>
            <Link
              href={`/dashboard/${project.id}`}
              title={project.name}
              className={
                "block truncate rounded-md px-2 py-1 text-sm " +
                (project.id === activeProjectId
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-background")
              }
            >
              {project.name}
            </Link>
          </li>
        ))}
      </ul>

      <Link href="/settings" className="shrink-0 text-xs text-muted hover:underline">
        Settings
      </Link>
    </div>
  );
}
