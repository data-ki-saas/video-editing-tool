"use client";

/**
 * Project switcher, living inside the Action Area (left of the asset
 * gallery) rather than as a persistent full-height sidebar. Replaces that
 * role from the now-removed DashboardSidebar -- "Settings" is kept here too
 * since it had no other home once the sidebar went away.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listProjects, deleteProject, type Project } from "@/lib/projects";
import { ContextMenu, useContextMenu } from "./ContextMenu";

export function ProjectList({ activeProjectId }: { activeProjectId: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your reels"));
  }, []);

  async function handleDelete(project: Project) {
    if (!window.confirm(`Delete "${project.name}"? This can't be undone.`)) return;
    try {
      await deleteProject(project.id);
      setProjects((prev) => prev?.filter((p) => p.id !== project.id) ?? prev);
      // The deleted reel's own editor page is currently open under us --
      // bounce to bare /dashboard, which resumes into whichever reel is
      // next most recent (see lib/lastProject.ts).
      if (project.id === activeProjectId) router.push("/dashboard");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete this reel");
    }
  }

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
          <li
            key={project.id}
            onContextMenu={(e) =>
              openContextMenu(e, [{ label: "Delete", danger: true, onSelect: () => void handleDelete(project) }])
            }
          >
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

      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}
