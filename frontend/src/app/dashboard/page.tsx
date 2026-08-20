"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listProjects, type Project } from "@/lib/projects";

function formatNicheLabel(niche: string | null): string | null {
  if (!niche) return null;
  return niche.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function summarizeAttributes(attributes: Record<string, string | number>): string {
  return Object.values(attributes).slice(0, 3).join(" · ");
}

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your reels"));
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Your reels</h1>
        <Link
          href="/dashboard/new"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
        >
          + New Reel
        </Link>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !projects && <p className="text-sm text-neutral-500">Loading…</p>}
      {projects && projects.length === 0 && (
        <p className="text-sm text-neutral-500">
          No reels yet — click &quot;New Reel&quot; to create your first one.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {projects?.map((project) => (
          <li key={project.id}>
            <Link
              href={`/dashboard/${project.id}`}
              className="flex flex-col gap-0.5 rounded-md border border-neutral-300 px-4 py-3 hover:bg-neutral-100"
            >
              <span className="font-medium">{project.name}</span>
              <span className="text-sm text-neutral-500">
                {[formatNicheLabel(project.niche), summarizeAttributes(project.attributes)]
                  .filter(Boolean)
                  .join(" · ") || "No details yet"}
                {project.render_status ? ` · ${project.render_status}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
