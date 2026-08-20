import type { Metadata } from "next";
import Link from "next/link";

// Requires auth (see src/lib/supabase/middleware.ts) -- noindex since crawlers would just hit a redirect.
export const metadata: Metadata = {
  title: "Dashboard",
  description: "Upload videos and edit your Reel timeline.",
  robots: { index: false, follow: false },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <div className="flex items-center justify-end gap-4 border-b border-neutral-200 px-4 py-2 text-sm">
        <Link href="/settings" className="text-neutral-500 hover:underline">
          Settings
        </Link>
      </div>
      {children}
    </div>
  );
}
