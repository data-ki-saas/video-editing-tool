"use client";

/**
 * A generic horizontal step indicator for any guided creation flow --
 * doesn't know anything about niches, reels, or media slots. Pass whatever
 * step ids/labels a given wizard has; it just renders where the user is and
 * what's still ahead. Used by NicheWizard today, but reusable for any future
 * multi-step flow this app adds.
 */
export interface WizardStep {
  id: string;
  label: string;
}

export function WizardProgress({ steps, currentStepId }: { steps: WizardStep[]; currentStepId: string }) {
  const currentIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === currentStepId)
  );

  return (
    <nav aria-label="Reel creation progress" className="w-full">
      {/* Full stepper -- circles + labels + connecting lines. Hidden below
          sm: the label text plus fixed circle width doesn't have room to
          breathe on a phone-width screen, so narrow viewports get the
          compact bar below instead. */}
      <ol className="hidden items-start sm:flex">
        {steps.map((step, index) => {
          const isCompleted = index < currentIndex;
          const isCurrent = index === currentIndex;
          return (
            <li key={step.id} className="flex flex-1 flex-col items-center last:flex-none">
              <div className="flex w-full items-center">
                <div
                  aria-current={isCurrent ? "step" : undefined}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                    isCompleted
                      ? "bg-accent text-accent-foreground"
                      : isCurrent
                        ? "border-2 border-accent text-accent"
                        : "border border-border text-muted"
                  }`}
                >
                  {isCompleted ? "✓" : index + 1}
                </div>
                {index < steps.length - 1 && (
                  <div className={`mx-1 h-px flex-1 ${isCompleted ? "bg-accent" : "bg-border"}`} />
                )}
              </div>
              <span className={`mt-1.5 text-center text-xs ${isCurrent ? "font-medium text-foreground" : "text-muted"}`}>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Compact fallback for narrow viewports: current position + a thin
          progress bar, no per-step circles. */}
      <div className="flex flex-col gap-1.5 sm:hidden">
        <p className="text-xs font-medium text-muted">
          Step {currentIndex + 1} of {steps.length} — {steps[currentIndex]?.label}
        </p>
        <div className="h-1 w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${((currentIndex + 1) / steps.length) * 100}%` }}
          />
        </div>
      </div>
    </nav>
  );
}
