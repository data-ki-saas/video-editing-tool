export function BackgroundPanel({
  disabled,
  added,
  onAdd,
}: {
  disabled: boolean;
  added: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Artificial Background</h2>
      <p className="text-sm text-muted">
        Full background generation is coming soon. For now, this adds a solid dark backdrop behind your video.
      </p>
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled || added}
        className="self-start rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-40"
      >
        {added ? "Background added" : "Add background"}
      </button>
    </div>
  );
}
