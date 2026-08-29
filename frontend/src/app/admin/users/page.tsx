"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { listRoles, listUsers, updateUserRole, type AdminUserInfo, type RoleInfo } from "@/lib/api";

export default function AdminUsersPage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();

  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<AdminUserInfo[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin === false) router.replace("/dashboard");
  }, [isAdmin, router]);

  useEffect(() => {
    if (isAdmin !== true) return;
    listRoles().catch(() => undefined).then((result) => result && setRoles(result));
  }, [isAdmin]);

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault();
    setIsSearching(true);
    setError(null);
    try {
      setUsers(await listUsers(search.trim() || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to search users");
    } finally {
      setIsSearching(false);
    }
  }

  async function handleRoleChange(user: AdminUserInfo, newRole: string) {
    setSavingUserId(user.id);
    setError(null);
    try {
      const updated = await updateUserRole(user.id, newRole);
      setUsers((prev) => (prev ?? []).map((u) => (u.id === user.id ? updated : u)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update this user's role");
    } finally {
      setSavingUserId(null);
    }
  }

  if (isAdmin !== true) return null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12">
      <div>
        <Link href="/admin" className="text-sm text-muted hover:underline">
          ← Admin
        </Link>
        <h1 className="text-2xl font-semibold">Users</h1>
      </div>

      <form onSubmit={runSearch} className="flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by email…"
          className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
        <button
          type="submit"
          disabled={isSearching}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {isSearching ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {users === null ? (
        <p className="text-sm text-muted">Search for a user by email to change their role.</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-muted">No users found.</p>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-md border border-border">
          {users.map((user) => (
            <div key={user.id} className="flex items-center justify-between gap-3 p-3">
              <div>
                <p className="text-sm font-medium">{user.email ?? user.id}</p>
                {user.displayName && <p className="text-xs text-muted">{user.displayName}</p>}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-medium text-white"
                  style={{ backgroundColor: user.badgeColor }}
                >
                  {user.roleLabel}
                </span>
                <select
                  value={user.role}
                  disabled={savingUserId === user.id}
                  onChange={(e) => handleRoleChange(user, e.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground disabled:opacity-50"
                >
                  {roles.map((role) => (
                    <option key={role.key} value={role.key}>
                      {role.displayName}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
