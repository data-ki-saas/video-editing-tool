import { GlobalTopNav } from "@/components/GlobalTopNav";

// Route group (parens excluded from the URL) wrapping every authenticated
// page -- dashboard, library, recordings, settings, admin, account -- so
// they all share one nav bar instead of each maintaining (or omitting) its
// own. Same shrink-0-header + min-h-0/flex-1/overflow-y-auto shape
// dashboard/(chrome)/layout.tsx used to prove out just for bare /dashboard.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <GlobalTopNav />
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
