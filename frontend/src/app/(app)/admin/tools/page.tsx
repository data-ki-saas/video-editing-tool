"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { rebakeAllAvatars, configureR2Cors, type RebakeAvatarsResult, type ConfigureR2CorsResult } from "@/lib/api";

type RunState<T> = { status: "idle" | "running" } | { status: "done"; result: T } | { status: "error"; message: string };

/** One tool = a name/description, a run button, and its own independent
 * run/result/error state -- each tool here wraps a backend/scripts/*.py
 * script an admin would otherwise need shell + DB/R2 credentials to run. */
function ToolCard<T>({
  title,
  description,
  runLabel,
  confirmMessage,
  onRun,
  renderResult,
}: {
  title: string;
  description: string;
  runLabel: string;
  confirmMessage: string;
  onRun: () => Promise<T>;
  renderResult: (result: T) => React.ReactNode;
}) {
  const [state, setState] = useState<RunState<T>>({ status: "idle" });

  async function handleClick() {
    if (!window.confirm(confirmMessage)) return;
    setState({ status: "running" });
    try {
      const result = await onRun();
      setState({ status: "done", result });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Something went wrong" });
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-sm text-muted">{description}</p>
      </div>
      <div>
        <button
          type="button"
          onClick={handleClick}
          disabled={state.status === "running"}
          className="rounded-md border border-border bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          {state.status === "running" ? "Running…" : runLabel}
        </button>
      </div>
      {state.status === "error" && <p className="text-sm text-red-600">{state.message}</p>}
      {state.status === "done" && <div className="text-sm text-muted">{renderResult(state.result)}</div>}
    </section>
  );
}

export default function AdminToolsPage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();

  useEffect(() => {
    if (isAdmin === false) router.replace("/dashboard");
  }, [isAdmin, router]);

  if (isAdmin !== true) return null;

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Tools</h1>
        <p className="text-sm text-muted">
          One-off ops scripts, runnable without shell/DB access. See backend/scripts/ for the CLI equivalents these
          call the exact same underlying logic as.
        </p>
      </div>

      <ToolCard<RebakeAvatarsResult>
        title="Rebake avatars"
        description="Re-applies today's atlas-baking code (mouth position, eyebrows, transparency, ...) to every fal.ai-generated avatar with a cached source photo, across all users. Run after shipping a fix in backend/src/avatar_gen/atlas_builder.py."
        runLabel="Rebake all avatars"
        confirmMessage="Rebake every fal.ai avatar with a cached source photo, for every user? This can take a while."
        onRun={rebakeAllAvatars}
        renderResult={(result) => (
          <p>
            {result.succeeded} of {result.total} rebaked{result.failed > 0 ? `, ${result.failed} failed (see backend logs)` : ""}.
          </p>
        )}
      />

      <ToolCard<ConfigureR2CorsResult>
        title="Reapply R2 CORS policy"
        description="(Re-)applies the private uploads bucket's CORS policy from today's CORS_ORIGINS. Safe to run repeatedly. Only needed again after CORS_ORIGINS changes -- e.g. adding a new frontend domain."
        runLabel="Reapply CORS policy"
        confirmMessage="Reapply the uploads bucket's CORS policy from the backend's current CORS_ORIGINS?"
        onRun={configureR2Cors}
        renderResult={(result) => (
          <p>
            Applied to <span className="font-mono text-xs">{result.bucket}</span> for: {result.origins.join(", ")}
          </p>
        )}
      />
    </div>
  );
}
