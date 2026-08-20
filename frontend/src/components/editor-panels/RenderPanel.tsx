export function RenderPanel({
  disabled,
  isRendering,
  renderStatus,
  renderUrl,
  renderError,
  isStuck,
  isTerminal,
  onRender,
}: {
  disabled: boolean;
  isRendering: boolean;
  renderStatus: string | null;
  renderUrl: string | null;
  renderError: string | null;
  isStuck: boolean;
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

      {renderError && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          <p className="font-medium">Render failed</p>
          <p>{renderError}</p>
        </div>
      )}

      {!renderError && isStuck && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <p className="font-medium">This is taking longer than usual</p>
          <p>
            Most renders finish within a few minutes. This one has been in progress well past that, which
            usually means the final storage step failed silently on our end. You can keep waiting -- this
            will update automatically if it completes -- or start a new render if it doesn&apos;t resolve
            soon.
          </p>
        </div>
      )}

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
