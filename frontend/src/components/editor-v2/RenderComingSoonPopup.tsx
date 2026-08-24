"use client";

/**
 * Stand-in for the cloud (Creatomate) Render button while it's temporarily
 * disabled -- see ThreePaneEditor.tsx's handleRenderClick, which shows this
 * instead of actually calling startRender(). Same small-modal chrome as
 * StockPreviewPopup.tsx (backdrop closes on click, card stops propagation).
 */
export function RenderComingSoonPopup({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="High quality rendering coming soon"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-lg bg-surface p-4 shadow-lg">
        <p className="text-sm text-foreground">High quality rendering coming soon.</p>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full rounded-md bg-accent py-1.5 text-sm font-medium text-accent-foreground"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
