import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Reel Creator handles your data.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <h1 className="text-3xl font-semibold">Privacy Policy</h1>

      {/* Placeholder -- this is not a real, legally-reviewed privacy policy.
          Replace before handling real user data at any meaningful scale. */}
      <p className="text-sm text-neutral-500">Last updated: placeholder — not yet legally reviewed.</p>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">What we collect</h2>
        <p className="text-neutral-600">
          Your account email, the photos/videos you upload to create reels, and the
          reels themselves. We don&apos;t sell your data to third parties.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Where it&apos;s stored</h2>
        <p className="text-neutral-600">
          Account data lives in Supabase; uploaded media and finished videos are stored
          in Cloudflare R2. Uploaded source files are kept private and are only ever
          accessed through short-lived, authenticated links.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Questions</h2>
        <p className="text-neutral-600">
          Reach out via the <a href="/contact" className="underline">Contact</a> page
          with any privacy questions.
        </p>
      </section>
    </main>
  );
}
