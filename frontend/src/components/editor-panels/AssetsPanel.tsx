import type { Asset } from "@/lib/api";

export function AssetsPanel({
  videoAssets,
  selectedAssetId,
  onSelect,
}: {
  videoAssets: Asset[];
  selectedAssetId: string | null;
  onSelect: (asset: Asset) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Your videos</h2>
      {videoAssets.length === 0 ? (
        <p className="text-sm text-muted">
          No videos yet — open &quot;Upload&quot; in the sidebar to get started.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {videoAssets.map((asset) => (
            <li key={asset.id}>
              <button
                type="button"
                className={
                  "w-full rounded-md border px-3 py-1.5 text-left text-sm hover:bg-background " +
                  (asset.id === selectedAssetId ? "border-accent font-medium" : "border-border")
                }
                onClick={() => onSelect(asset)}
              >
                {asset.filename}
                {asset.id === selectedAssetId ? " (selected)" : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
