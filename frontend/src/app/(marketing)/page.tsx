import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="text-3xl font-semibold">Timeline Editor</h1>
      <p className="text-neutral-600">
        Upload a video, trim it, add a background or overlay, and render a
        finished 9:16 Reel — all from your browser.
      </p>
      <ol className="flex flex-col gap-1 text-left text-sm text-neutral-500">
        <li>1. Sign up or sign in</li>
        <li>2. Upload a video from your dashboard</li>
        <li>3. Select it, then trim / add a background / overlay an image</li>
        <li>4. Render the finished video</li>
      </ol>
      <div className="flex gap-3">
        <Link
          href="/signup"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Sign up
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
