"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/useIsAdmin";

// Client-side guard only -- every real admin endpoint this links to is
// gated server-side by require_feature("admin_manage_roles") (see
// backend/src/permissions/router.py); this redirect just keeps a
// non-admin from seeing the admin nav at all.
export default function AdminPage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();

  useEffect(() => {
    if (isAdmin === false) router.replace("/dashboard");
  }, [isAdmin, router]);

  if (isAdmin !== true) return null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-12">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <div className="flex flex-col gap-3">
        <Link
          href="/admin/roles"
          className="rounded-md border border-border p-4 hover:bg-surface"
        >
          <p className="font-medium">Roles & permissions</p>
          <p className="text-sm text-muted">Create roles and choose which features each one can use.</p>
        </Link>
        <Link
          href="/admin/users"
          className="rounded-md border border-border p-4 hover:bg-surface"
        >
          <p className="font-medium">Users</p>
          <p className="text-sm text-muted">Look up a user by email and change their role.</p>
        </Link>
      </div>
    </main>
  );
}
