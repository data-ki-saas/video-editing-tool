export function TrimPanel({
  disabled,
  trim,
  onApply,
}: {
  disabled: boolean;
  trim: { trim_start: number; trim_duration: number } | null;
  onApply: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Trim</h2>
      <p className="text-sm text-muted">
        Full clip/track trimming is coming soon. For now, apply a fixed 5-second clip starting at 0.
      </p>
      {trim && (
        <p className="text-xs text-muted">
          Current: {trim.trim_start}s – {trim.trim_start + trim.trim_duration}s
        </p>
      )}
      <button
        type="button"
        onClick={onApply}
        disabled={disabled}
        className="self-start rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-40"
      >
        Apply 5s trim
      </button>
    </div>
  );
}
