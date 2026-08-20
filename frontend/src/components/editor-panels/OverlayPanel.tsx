import type { Asset } from "@/lib/api";

export function OverlayPanel({
  disabled,
  imageAssets,
  added,
  onAdd,
}: {
  disabled: boolean;
  imageAssets: Asset[];
  added: boolean;
  onAdd: (asset: Asset) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Overlay Image</h2>
      {imageAssets.length === 0 ? (
        <p className="text-sm text-muted">Upload an image to use it as an overlay.</p>
      ) : added ? (
        <p className="text-sm text-muted">An overlay image has been added.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {imageAssets.map((asset) => (
            <li key={asset.id}>
              <button
                type="button"
                onClick={() => onAdd(asset)}
                disabled={disabled}
                className="w-full rounded-md border border-border px-3 py-1.5 text-left text-sm hover:bg-background disabled:cursor-not-allowed disabled:opacity-40"
              >
                {asset.filename}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
