export default function DashboardPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-lg font-semibold">Select a reel</h1>
      <p className="max-w-sm text-sm text-muted">
        Choose a reel from the sidebar to start editing, or click &quot;+ Project&quot; to create a new one.
      </p>
    </div>
  );
}
