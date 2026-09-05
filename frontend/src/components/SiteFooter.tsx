import Link from "next/link";

const FOOTER_LINKS = [
  { href: "/whats-new", label: "What's New" },
  { href: "/about", label: "About Us" },
  { href: "/contact", label: "Contact Us" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Documentation" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Use" },
];

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-3 px-4 py-8 text-sm text-muted sm:flex-row sm:justify-between">
        <nav className="flex flex-wrap items-center justify-center gap-4">
          {FOOTER_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="underline">
              {link.label}
            </Link>
          ))}
        </nav>
        <p>&copy; {new Date().getFullYear()} Reel Creator. All rights reserved.</p>
      </div>
    </footer>
  );
}
