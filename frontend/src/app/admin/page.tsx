"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/useIsAdmin";

// Placeholder -- what the admin app actually does is scoped separately.
// This page exists so the header's admin-only Tools icon has somewhere to
// go, and so the client-side isAdmin === false redirect is in place before
// any real admin functionality lands. Note this guard is client-side only;
// any real admin data/actions added here must be served by an endpoint
// gated with backend/src/core/auth.py's require_admin, not this check alone.
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
      <p className="text-sm text-muted">Coming soon.</p>
    </main>
  );
}
