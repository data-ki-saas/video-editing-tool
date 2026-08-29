"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/useIsAdmin";
import {
  listFeatures,
  listRoles,
  updateRole,
  updateRoleFeatures,
  type FeatureInfo,
  type RoleInfo,
} from "@/lib/api";

export default function AdminRoleDetailPage({ params }: { params: Promise<{ roleKey: string }> }) {
  const { roleKey } = use(params);
  const router = useRouter();
  const isAdmin = useIsAdmin();

  const [features, setFeatures] = useState<FeatureInfo[] | null>(null);
  const [role, setRole] = useState<RoleInfo | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [displayName, setDisplayName] = useState("");
  const [badgeColor, setBadgeColor] = useState("#64748b");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (isAdmin === false) router.replace("/dashboard");
  }, [isAdmin, router]);

  useEffect(() => {
    if (isAdmin !== true) return;
    Promise.all([listFeatures(), listRoles()])
      .then(([featureList, roles]) => {
        setFeatures(featureList);
        const found = roles.find((r) => r.key === roleKey) ?? null;
        setRole(found);
        if (found) {
          setSelected(new Set(found.features));
          setDisplayName(found.displayName);
          setBadgeColor(found.badgeColor);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load role"));
  }, [isAdmin, roleKey]);

  const grouped = useMemo(() => {
    const groups = new Map<string, FeatureInfo[]>();
    for (const feature of features ?? []) {
      const list = groups.get(feature.group) ?? [];
      list.push(feature);
      groups.set(feature.group, list);
    }
    return groups;
  }, [features]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSave() {
    if (!role || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      const [updatedRole] = await Promise.all([
        updateRole(role.key, { displayName, badgeColor }),
        updateRoleFeatures(role.key, Array.from(selected)),
      ]);
      setRole(updatedRole);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save this role");
    } finally {
      setIsSaving(false);
    }
  }

  if (isAdmin !== true) return null;
  if (!role || !features) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-12">
        {error ? <p className="text-sm text-red-600">{error}</p> : <p className="text-sm text-muted">Loading…</p>}
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12">
      <div>
        <Link href="/admin/roles" className="text-sm text-muted hover:underline">
          ← Roles
        </Link>
        <h1 className="text-2xl font-semibold">
          {role.displayName} <span className="font-mono text-base text-muted">({role.key})</span>
        </h1>
      </div>

      <section className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Display name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Badge color
          <input
            type="color"
            value={badgeColor}
            onChange={(e) => setBadgeColor(e.target.value)}
            className="h-8 w-14 rounded-md border border-border bg-background p-0.5"
          />
        </label>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium text-white"
          style={{ backgroundColor: badgeColor }}
        >
          {displayName || role.displayName}
        </span>
      </section>

      <section className="flex flex-col gap-4">
        {Array.from(grouped.entries()).map(([group, groupFeatures]) => (
          <div key={group} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-muted">{group}</h2>
            <div className="flex flex-col gap-1 rounded-md border border-border p-2">
              {groupFeatures.map((feature) => (
                <label key={feature.key} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-surface">
                  <input
                    type="checkbox"
                    checked={selected.has(feature.key)}
                    onChange={() => toggle(feature.key)}
                    className="h-4 w-4"
                  />
                  {feature.label}
                </label>
              ))}
            </div>
          </div>
        ))}
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
        {savedAt && !isSaving && <span className="text-xs text-green-600">Saved</span>}
      </div>
    </main>
  );
}
