"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { createRole, deleteRole, listRoles, type RoleInfo } from "@/lib/api";

const DEFAULT_BADGE_COLOR = "#64748b";

export default function AdminRolesPage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();

  const [roles, setRoles] = useState<RoleInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newKey, setNewKey] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newBadgeColor, setNewBadgeColor] = useState(DEFAULT_BADGE_COLOR);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin === false) router.replace("/dashboard");
  }, [isAdmin, router]);

  useEffect(() => {
    // Fetched in parallel with the isAdmin check (not gated on it) -- see
    // admin/users/page.tsx's own comment on why.
    listRoles()
      .then(setRoles)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load roles"));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newKey.trim() || !newDisplayName.trim() || isCreating) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      const role = await createRole({ key: newKey.trim(), displayName: newDisplayName.trim(), badgeColor: newBadgeColor });
      setRoles((prev) => [...(prev ?? []), role]);
      setNewKey("");
      setNewDisplayName("");
      setNewBadgeColor(DEFAULT_BADGE_COLOR);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create role");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDelete(role: RoleInfo) {
    if (!window.confirm(`Delete the "${role.displayName}" role?`)) return;
    setError(null);
    try {
      await deleteRole(role.key);
      setRoles((prev) => (prev ?? []).filter((r) => r.key !== role.key));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete role");
    }
  }

  if (isAdmin !== true) return null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-12">
      <div>
        <Link href="/admin" className="text-sm text-muted hover:underline">
          ← Admin
        </Link>
        <h1 className="text-2xl font-semibold">Roles & permissions</h1>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {roles === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-md border border-border">
          {roles.map((role) => (
            <div key={role.key} className="flex items-center justify-between gap-3 p-3">
              <div className="flex items-center gap-2">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: role.badgeColor }}
                  aria-hidden
                />
                <div>
                  <p className="text-sm font-medium">
                    {role.displayName}{" "}
                    <span className="font-mono text-xs text-muted">({role.key})</span>
                  </p>
                  <p className="text-xs text-muted">
                    {role.userCount} user{role.userCount === 1 ? "" : "s"}
                    {role.isSystem && " · built-in"}
                    {role.isDefault && " · default for new signups"}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  href={`/admin/roles/${encodeURIComponent(role.key)}`}
                  className="rounded-md border border-border px-3 py-1 text-sm hover:bg-surface"
                >
                  Manage
                </Link>
                <button
                  type="button"
                  onClick={() => handleDelete(role)}
                  disabled={role.isSystem}
                  title={role.isSystem ? "Built-in roles can't be deleted" : undefined}
                  className="rounded-md border border-border px-3 py-1 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleCreate} className="flex flex-col gap-3 rounded-md border border-dashed border-border p-4">
        <h2 className="text-sm font-medium">New role</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Key (lowercase, underscores)
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="e.g. agency_user"
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Display name
            <input
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder="e.g. Agency"
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Badge color
            <input
              type="color"
              value={newBadgeColor}
              onChange={(e) => setNewBadgeColor(e.target.value)}
              className="h-8 w-14 rounded-md border border-border bg-background p-0.5"
            />
          </label>
          <button
            type="submit"
            disabled={!newKey.trim() || !newDisplayName.trim() || isCreating}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {isCreating ? "Creating…" : "Create role"}
          </button>
        </div>
        {createError && <p className="text-sm text-red-600">{createError}</p>}
      </form>
    </main>
  );
}
