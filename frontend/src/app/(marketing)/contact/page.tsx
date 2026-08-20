import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Get in touch with the Reel Creator team.",
  alternates: { canonical: "/contact" },
};

// Placeholder contact details -- replace with a real monitored inbox (and,
// eventually, a working contact form) before this page goes live for real.
const CONTACT_EMAIL = "hello@example.com";

export default function ContactPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <h1 className="text-3xl font-semibold">Contact Us</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Get in touch</h2>
        <p className="text-neutral-600">
          Questions, feedback, or need help with a reel that didn&apos;t render right?
          Reach out and we&apos;ll get back to you.
        </p>
        <a href={`mailto:${CONTACT_EMAIL}`} className="text-lg font-medium underline">
          {CONTACT_EMAIL}
        </a>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Response time</h2>
        <p className="text-neutral-600">
          {/* Placeholder -- set real expectations once support is actually staffed. */}
          We&apos;re a small team in early access, so replies may take a day or two.
        </p>
      </section>
    </main>
  );
}
