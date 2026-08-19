import type { Metadata } from "next";

// Requires auth (see src/proxy.ts) -- noindex since crawlers would just hit a redirect.
export const metadata: Metadata = {
  title: "Dashboard",
  description: "Upload videos and edit your Reel timeline.",
  robots: { index: false, follow: false },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen">{children}</div>;
}
