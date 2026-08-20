"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function DashboardNav() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex items-center justify-end gap-4 border-b border-border px-4 py-2 text-sm">
      <Link href="/settings" className="text-muted hover:underline">
        Settings
      </Link>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className="text-muted hover:underline disabled:opacity-50"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
