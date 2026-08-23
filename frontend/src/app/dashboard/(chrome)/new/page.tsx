"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/lib/projects";
import { getOrCreateNiche, type NicheConfig } from "@/lib/niches";

const inputClass = "rounded-md border border-neutral-300 px-3 py-2 text-sm";

export default function NewReelPage() {
  const router = useRouter();

  const [step, setStep] = useState<"niche" | "details">("niche");
  const [nicheName, setNicheName] = useState("");
  const [niche, setNiche] = useState<NicheConfig | null>(null);
  const [nicheError, setNicheError] = useState<string | null>(null);
  const [loadingNiche, setLoadingNiche] = useState(false);

  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleNicheSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!nicheName.trim()) return;

    setLoadingNiche(true);
    setNicheError(null);
    try {
      // First time any given niche is requested, the backend's configured
      // LLM provider generates its field schema + script template -- can
      // take a few seconds; instant on every call after that.
      const config = await getOrCreateNiche(nicheName.trim());
      setNiche(config);
      setStep("details");
    } catch (err) {
      setNicheError(err instanceof Error ? err.message : "Failed to set up that niche");
    } finally {
      setLoadingNiche(false);
    }
  }

  async function handleDetailsSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!niche) return;
    if (!name.trim()) {
      setCreateError("Give this reel a name");
      return;
    }

    const attributes: Record<string, string | number> = {};
    for (const field of niche.fields) {
      const raw = values[field.key];
      if (raw === undefined || raw === "") continue;
      attributes[field.key] = field.type === "number" ? Number(raw) : raw;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const project = await createProject({ name: name.trim(), niche: niche.niche_key, attributes });
      router.push(`/dashboard/${project.id}`);
    } catch (err) {
      setCreating(false);
      setCreateError(err instanceof Error ? err.message : "Failed to create reel");
    }
  }

  if (step === "niche" || !niche) {
    return (
      <main className="mx-auto flex max-w-sm flex-col gap-6 p-6">
        <h1 className="text-xl font-semibold">New Reel</h1>
        <p className="text-sm text-neutral-500">
          What kind of business is this reel for? (e.g. real estate, hotel, auto dealership, garment
          shop, gift shop, hardware store — anything works)
        </p>

        <form onSubmit={handleNicheSubmit} className="flex flex-col gap-3">
          <input
            placeholder="Business niche"
            value={nicheName}
            onChange={(e) => setNicheName(e.target.value)}
            className={inputClass}
            required
          />
          {nicheError && <p className="text-sm text-red-600">{nicheError}</p>}
          <button
            type="submit"
            disabled={loadingNiche}
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {loadingNiche ? "Setting up…" : "Continue"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-6">
      <div>
        <button type="button" onClick={() => setStep("niche")} className="text-sm text-neutral-500 hover:underline">
          ← Change niche
        </button>
        <h1 className="text-xl font-semibold">{niche.display_name}</h1>
      </div>

      <form onSubmit={handleDetailsSubmit} className="flex flex-col gap-3">
        <input
          placeholder="Reel name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          required
        />

        {niche.fields.map((field) =>
          field.type === "textarea" ? (
            <textarea
              key={field.key}
              placeholder={field.label}
              value={values[field.key] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              className={`${inputClass} min-h-20`}
              required={field.required}
            />
          ) : (
            <input
              key={field.key}
              type={field.type === "number" ? "number" : "text"}
              placeholder={field.label}
              value={values[field.key] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              className={inputClass}
              required={field.required}
            />
          )
        )}

        {createError && <p className="text-sm text-red-600">{createError}</p>}

        <button
          type="submit"
          disabled={creating}
          className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create Reel"}
        </button>
      </form>
    </main>
  );
}
