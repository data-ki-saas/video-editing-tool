"use client";

/** Standalone sign-out control -- lives in the dashboard's persistent top
 * bar (see app/dashboard/layout.tsx) now that the old left sidebar (which
 * used to host this) is gone. /settings also has its own copy; harmless
 * duplication, not worth threading shared state for. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { PowerIcon } from "@/components/icons/UIIcons";

export function SignOutButton() {
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
    <button
      type="button"
      onClick={handleSignOut}
      disabled={signingOut}
      aria-label={signingOut ? "Signing out…" : "Sign out"}
      title={signingOut ? "Signing out…" : "Sign out"}
      className="rounded-full p-2 text-red-600 hover:bg-red-600/10 disabled:opacity-50"
    >
      <PowerIcon className="h-5 w-5" />
    </button>
  );
}
