"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { prefetchPermissions } from "@/lib/usePermissions";

export default function SignupPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkEmailMessage, setCheckEmailMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCheckEmailMessage(null);
    setLoading(true);

    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        // Without this, Supabase falls back to whatever "Site URL" happens
        // to be configured in the dashboard -- often still the default
        // localhost, regardless of which environment signup actually
        // happened from. This always points the confirmation link back at
        // wherever the user actually is. Still requires this origin to be
        // listed in Supabase's Auth > URL Configuration > Redirect URLs
        // allow-list, or Supabase will reject it and fall back anyway.
        emailRedirectTo: `${window.location.origin}/login`,
      },
    });
    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    if (!data.session) {
      // Email confirmation is required -- signUp() returns a user but no
      // session until the confirmation link is clicked. Redirecting to
      // /dashboard here would just bounce straight back to /login with no
      // explanation (see src/lib/supabase/middleware.ts).
      setCheckEmailMessage("Check your email to confirm your account, then sign in.");
      return;
    }

    prefetchPermissions();

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Create an account</h1>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
        />
        <input
          type="password"
          required
          minLength={6}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
        />

        {error && <p className="text-sm text-red-500">{error}</p>}
        {checkEmailMessage && <p className="text-sm text-green-500">{checkEmailMessage}</p>}

        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Please wait…" : "Sign up"}
        </button>
      </form>

      <Link href="/login" className="text-sm underline">
        Already have an account? Sign in
      </Link>
    </main>
  );
}
