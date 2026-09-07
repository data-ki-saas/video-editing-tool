"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// The four action cards this page used to show are now the persistent
// sidebar in admin/layout.tsx, so the bare /admin index has nothing of its
// own left to render -- forward straight to the first section. (Roles'
// own isAdmin guard still redirects a non-admin to /dashboard.)
export default function AdminPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/roles");
  }, [router]);

  return null;
}
