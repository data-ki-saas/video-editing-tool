export function RenderPanel({
  disabled,
  isRendering,
  renderStatus,
  renderUrl,
  renderError,
  isTerminal,
  onRender,
}: {
  disabled: boolean;
  isRendering: boolean;
  renderStatus: string | null;
  renderUrl: string | null;
  renderError: string | null;
  isTerminal: boolean;
  onRender: () => void;
}) {
  const isProcessing = isRendering || (renderStatus !== null && !isTerminal);

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Render</h2>
      <p className="text-sm text-muted">
        Rendering happens off-platform and can take a few minutes -- this panel updates automatically, no
        need to keep it open.
      </p>
      <button
        type="button"
        onClick={onRender}
        disabled={disabled}
        className="self-start rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isRendering ? "Starting render…" : "Render"}
      </button>
      {renderError && <p className="text-sm text-red-600">{renderError}</p>}
      {renderStatus && (
        <p className="flex items-center gap-2 text-sm text-muted">
          {isProcessing && (
            <span
              className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden="true"
            />
          )}
          <span>
            Render status: <span className="font-medium text-foreground">{renderStatus}</span>
            {renderStatus === "completed" && renderUrl && (
              <>
                {" — "}
                <a href={renderUrl} target="_blank" rel="noreferrer" className="underline">
                  view finished video
                </a>
              </>
            )}
          </span>
        </p>
      )}
    </div>
  );
}
