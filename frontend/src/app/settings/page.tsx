"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SettingsPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-12">
      <div>
        <Link href="/dashboard" className="text-sm text-neutral-500 hover:underline">
          ← Your reels
        </Link>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Account</h2>
        <p className="text-sm text-neutral-600">{email ?? "Loading…"}</p>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="self-start rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100 disabled:opacity-50"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </section>

      <section className="flex flex-col gap-2 rounded-md border border-dashed border-neutral-300 p-4">
        <h2 className="text-lg font-medium text-neutral-500">Branding</h2>
        <p className="text-sm text-neutral-500">
          {/* Placeholder -- ties to the deferred white-label/agency-tier idea.
              Not built yet; kept on the backlog until core usability is established. */}
          Coming soon: add your logo and brand colors to apply consistently across every
          reel you create.
        </p>
      </section>
    </main>
  );
}
