import Link from "next/link";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <Link href="/" className="font-semibold">
          Timeline Editor
        </Link>
        <nav className="flex gap-4 text-sm">
          <Link href="/login" className="hover:underline">
            Sign in
          </Link>
          <Link href="/signup" className="hover:underline">
            Sign up
          </Link>
        </nav>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
