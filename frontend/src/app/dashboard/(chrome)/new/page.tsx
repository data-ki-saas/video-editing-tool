"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type Asset,
  type AvatarGeneration,
  type AvatarOption,
  deleteAsset,
  generateAvatarVideo,
  getAvatarGeneration,
  listAvatars,
  listTtsVoices,
  synthesizeTts,
  uploadAssetWithProgress,
  type TtsVoiceOption,
} from "@/lib/api";
import { downscaleImageIfNeeded } from "@/lib/image";
import { getOrCreateNiche, listNiches, type MediaSlot, type NicheConfig } from "@/lib/niches";
import { createProject, renameProject, saveTimeline, updateProjectAttributes, type Project } from "@/lib/projects";
import { interpolateScript } from "@/lib/timeline/autoAssemble";
import { autoAssembleFromWizard, type WizardSlotAsset } from "@/lib/timeline/autoAssembleFromWizard";
import { createEmptyReelTimeline } from "@/lib/timeline/resolve";
import { getAudioDuration } from "@/lib/video/audio";
import { useCrossOriginImageSrcMap } from "@/lib/useCrossOriginImageSrc";
import { TEXT_TEMPLATE_OPTIONS } from "@/lib/video/textTemplates";
import { DEFAULT_TTS_OVERLAY_RECT, type TtsOverlay } from "@/lib/video/video_math";
import { WizardProgress, type WizardStep } from "@/components/wizard/WizardProgress";

const inputClass = "rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground";
const primaryButtonClass =
  "rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50";
const secondaryButtonClass =
  "rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-surface disabled:opacity-50";

type StepId = "niche" | "media" | "details" | "hook" | "contact" | "review";

const STEPS: WizardStep[] = [
  { id: "niche", label: "Get started" },
  { id: "media", label: "Media" },
  { id: "details", label: "Details" },
  { id: "hook", label: "Hook" },
  { id: "contact", label: "Contact" },
  { id: "review", label: "Review" },
];

// Every slot accepts either a photo or a video, regardless of the niche
// config's own `kind` hint (see MediaSlot) -- autoAssembleFromWizard.ts
// already Ken Burns-animates any photo into a moving clip wherever it
// lands, so hard-restricting a slot's file picker to video-only (as this
// used to do for kind === "video") just blocked a real-estate agent with
// only photos from filling a REQUIRED slot like "hero exterior" for no
// real technical reason. `kind`/`hint` stay purely advisory copy.
const SLOT_UPLOAD_ACCEPT = "video/mp4,image/jpeg,image/png";

interface ContactInfo {
  name: string;
  phone: string;
  whatsapp: string;
}

// Same list the marketing homepage advertises (see (marketing)/page.tsx's
// EXAMPLE_NICHES) -- shown as suggestions here too so a first-time user
// (before anyone's generated ANY niche yet, i.e. an empty niche_configs
// table) still has good starting options instead of a blank text box.
const SUGGESTED_NICHES = [
  "Real estate",
  "Hotels",
  "Short-term rentals",
  "Auto dealerships",
  "Garment shops",
  "Gift shops",
  "Hardware stores",
];

export default function NewReelPage() {
  const router = useRouter();

  const [step, setStep] = useState<StepId>("niche");

  // Niche step
  const [nicheName, setNicheName] = useState("");
  const [niche, setNiche] = useState<NicheConfig | null>(null);
  const [nicheError, setNicheError] = useState<string | null>(null);
  const [loadingNiche, setLoadingNiche] = useState(false);
  // Niches someone has already generated (and are therefore cached, so
  // picking one is instant and can't hit an LLM-generation failure) --
  // fetched once on mount, shown as a dropdown alongside the free-text
  // input rather than replacing it (any niche can still be typed fresh).
  const [existingNiches, setExistingNiches] = useState<NicheConfig[]>([]);
  // "I'll do it myself" bypass -- a separate flag from loadingNiche so the
  // two buttons' busy states don't get confused with each other while one
  // is pending.
  const [creatingBlank, setCreatingBlank] = useState(false);

  useEffect(() => {
    listNiches()
      .then(setExistingNiches)
      .catch(() => {
        // Non-fatal -- the dropdown just falls back to suggestions-only;
        // the free-text input still works either way.
      });
  }, []);

  // A draft project is created as soon as the niche resolves, so every
  // subsequent step (starting with Media) can upload straight into it via
  // the same uploadAssetWithProgress/deleteAsset calls the full editor's
  // own Upload panel uses -- no separate "staged files" upload path to
  // maintain, and the reel is resumable from the dashboard's project list
  // even if the wizard is abandoned partway.
  const [project, setProject] = useState<Project | null>(null);

  // Media step -- one uploaded Asset per media_slots key, plus per-slot
  // upload UI state keyed the same way.
  const [slotAssets, setSlotAssets] = useState<Record<string, Asset>>({});
  const [slotUploading, setSlotUploading] = useState<Record<string, boolean>>({});
  const [slotProgress, setSlotProgress] = useState<Record<string, number>>({});
  const [slotError, setSlotError] = useState<Record<string, string | null>>({});
  // Must never load a slot's asset.url via a plain <img> -- see
  // useCrossOriginImageSrcMap's own comment for why that can poison the
  // browser's cache against CanvasPlayer's later CORS-mode fetch of the
  // exact same URL once the wizard hands off to the editor.
  const slotImageSrcById = useCrossOriginImageSrcMap(
    Object.values(slotAssets)
      .filter((asset) => asset.kind === "image")
      .map((asset) => ({ id: asset.id, url: asset.url }))
  );

  // Details step
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});

  // Hook step
  const [selectedHook, setSelectedHook] = useState<string | "custom" | null>(null);
  const [customHook, setCustomHook] = useState("");
  const [highlights, setHighlights] = useState<[string, string, string]>(["", "", ""]);

  // Contact step
  const [contact, setContact] = useState<ContactInfo>({ name: "", phone: "", whatsapp: "" });
  const [ctaKeyword, setCtaKeyword] = useState("");

  // Review step -- voiceover
  const [narrationVoices, setNarrationVoices] = useState<TtsVoiceOption[]>([]);
  const [loadingNarrationVoices, setLoadingNarrationVoices] = useState(false);
  const [narrationVoicesError, setNarrationVoicesError] = useState<string | null>(null);
  // Empty string means "no voiceover" -- an explicit opt-in rather than a
  // default-on pick, since synthesis counts against the account's daily TTS
  // cap (see backend/src/core/config.py's tts_daily_cap) and a wizard-driven
  // reel shouldn't spend it without the creator choosing to.
  const [narrationVoice, setNarrationVoice] = useState("");
  // Delivers the narration as a lip-synced talking-avatar video (via
  // HeyGen) instead of audio-only -- only meaningful once a voice is
  // chosen, since the avatar lip-syncs to that generated audio rather than
  // doing its own text-to-speech. Off by default: unlike TTS, this has a
  // real per-generation cost (see backend/src/core/config.py's
  // avatar_daily_cap), so it's an explicit second opt-in, not bundled into
  // picking a voice.
  const [useAvatarVideo, setUseAvatarVideo] = useState(false);
  const [avatarOptions, setAvatarOptions] = useState<AvatarOption[]>([]);
  const [loadingAvatars, setLoadingAvatars] = useState(false);
  const [avatarsError, setAvatarsError] = useState<string | null>(null);
  // Empty string defers to the server's configured default avatar (see
  // backend's HEYGEN_DEFAULT_AVATAR_ID) -- set once the catalog loads and
  // the user hasn't picked one yet, same "seed a default once data loads"
  // pattern as TtsOverlayDialog's own voice <select>.
  const [selectedAvatarId, setSelectedAvatarId] = useState("");

  // Fetches the avatar catalog only once the checkbox is actually turned
  // on -- unlike voices (always shown), this is a live third-party API call
  // (see avatar/service.py) that most reels won't use, so it shouldn't fire
  // on every visit to the Review step.
  useEffect(() => {
    if (!useAvatarVideo || avatarOptions.length > 0 || loadingAvatars) return;
    let cancelled = false;
    setLoadingAvatars(true);
    listAvatars()
      .then((res) => {
        if (cancelled) return;
        setAvatarOptions(res.avatars);
        setSelectedAvatarId((prev) => prev || res.avatars[0]?.id || "");
      })
      .catch((err) => {
        if (!cancelled) setAvatarsError(err instanceof Error ? err.message : "Failed to load avatars");
      })
      .finally(() => {
        if (!cancelled) setLoadingAvatars(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- avatarOptions/loadingAvatars are read only to skip a redundant fetch, not to re-trigger one
  }, [useAvatarVideo]);

  // Review/generate
  const [generating, setGenerating] = useState(false);
  const [generatingStage, setGeneratingStage] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  /** Polls GET /api/avatar/generations/{id} until it reaches a terminal
   * status or the attempt budget runs out -- generation typically takes
   * 30-60s per HeyGen's docs, so this budgets a bit past that rather than
   * timing out right at the typical case. Returns the last-seen state
   * either way; a timeout looks the same to the caller as a slow "waiting"
   * (both fall back to audio-only narration, see handleGenerate). */
  async function pollAvatarGeneration(id: string): Promise<AvatarGeneration> {
    const POLL_INTERVAL_MS = 4000;
    const MAX_ATTEMPTS = 25; // ~100s
    let last = await getAvatarGeneration(id);
    for (let attempt = 0; attempt < MAX_ATTEMPTS && last.status === "waiting"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      last = await getAvatarGeneration(id);
    }
    return last;
  }

  function currentFieldValues(): Record<string, string | number> {
    const result: Record<string, string | number> = {};
    for (const [key, raw] of Object.entries(values)) {
      if (raw !== "") result[key] = raw;
    }
    return result;
  }

  function resolvedHookText(): string | null {
    const template = selectedHook === "custom" ? customHook.trim() : selectedHook;
    if (!template) return null;
    return interpolateScript(template, currentFieldValues());
  }

  function resolvedNarrationScript(): string | null {
    if (!niche?.script_template) return null;
    return interpolateScript(niche.script_template, currentFieldValues());
  }

  // Fetches the voice catalog once the Review step is reached -- same
  // fetch-on-mount pattern as TtsOverlayDialog, just triggered by step
  // instead of dialog-open, and skipped entirely for a niche with no
  // script_template (nothing to narrate).
  useEffect(() => {
    if (step !== "review" || !niche?.script_template) return;
    let cancelled = false;
    setLoadingNarrationVoices(true);
    listTtsVoices()
      .then((res) => {
        if (cancelled) return;
        setNarrationVoices(res.voices);
      })
      .catch((err) => {
        if (!cancelled) setNarrationVoicesError(err instanceof Error ? err.message : "Failed to load voices");
      })
      .finally(() => {
        if (!cancelled) setLoadingNarrationVoices(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, niche?.script_template]);

  async function submitNiche(rawName: string) {
    const trimmed = rawName.trim();
    if (!trimmed) return;

    setLoadingNiche(true);
    setNicheError(null);
    try {
      // First time any given niche is requested, the backend's configured
      // LLM provider generates its field/media-slot/hook schema -- can take
      // a few seconds; instant on every call after that (including when
      // picked from the "Already set up" dropdown below, which only ever
      // lists niches that succeeded before).
      const config = await getOrCreateNiche(trimmed);
      const draft = await createProject({
        name: `New ${config.display_name} Reel`,
        niche: config.niche_key,
        attributes: {},
      });
      setNiche(config);
      setProject(draft);
      setName(draft.name);
      setStep("media");
    } catch (err) {
      setNicheError(err instanceof Error ? err.message : "Failed to set up that niche");
    } finally {
      setLoadingNiche(false);
    }
  }

  function handleNicheSubmit(e: React.FormEvent) {
    e.preventDefault();
    void submitNiche(nicheName);
  }

  /** "I'll do it myself" -- skips the guided wizard entirely for someone
   * who already knows what they want. A blank project (no niche/attributes)
   * is still a normal project, so it's created the exact same way and lands
   * in the exact same full editor as a wizard-generated one -- there's just
   * nothing pre-assembled in its timeline yet. */
  async function handleSkipToEditor() {
    setCreatingBlank(true);
    setNicheError(null);
    try {
      const draft = await createProject({ name: "New Reel" });
      router.push(`/dashboard/${draft.id}`);
    } catch (err) {
      setNicheError(err instanceof Error ? err.message : "Failed to create a new reel");
      setCreatingBlank(false);
    }
  }

  async function handleSlotFileSelected(slot: MediaSlot, file: File) {
    if (!project) return;
    setSlotUploading((prev) => ({ ...prev, [slot.key]: true }));
    setSlotError((prev) => ({ ...prev, [slot.key]: null }));
    setSlotProgress((prev) => ({ ...prev, [slot.key]: 0 }));
    try {
      const uploadFile = await downscaleImageIfNeeded(file);
      const asset = await uploadAssetWithProgress(project.id, uploadFile, (fraction) =>
        setSlotProgress((prev) => ({ ...prev, [slot.key]: fraction }))
      );
      setSlotAssets((prev) => ({ ...prev, [slot.key]: asset }));
    } catch (err) {
      setSlotError((prev) => ({ ...prev, [slot.key]: err instanceof Error ? err.message : "Upload failed" }));
    } finally {
      setSlotUploading((prev) => ({ ...prev, [slot.key]: false }));
    }
  }

  async function handleSlotRemove(slot: MediaSlot) {
    const asset = slotAssets[slot.key];
    if (!asset) return;
    setSlotAssets((prev) => {
      const next = { ...prev };
      delete next[slot.key];
      return next;
    });
    try {
      await deleteAsset(asset.id);
    } catch {
      // The slot is already cleared client-side either way -- a failed
      // cleanup just leaves an orphaned asset row, not a stuck UI.
    }
  }

  function handleHighlightChange(index: 0 | 1 | 2, value: string) {
    setHighlights((prev) => {
      const next: [string, string, string] = [...prev];
      next[index] = value;
      return next;
    });
  }

  async function handleGenerate() {
    if (!project || !niche) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const fieldAttributes: Record<string, unknown> = {};
      for (const field of niche.fields) {
        const raw = values[field.key];
        if (raw === undefined || raw === "") continue;
        fieldAttributes[field.key] = field.type === "number" ? Number(raw) : raw;
      }

      const filteredHighlights = highlights.map((h) => h.trim()).filter((h) => h !== "");
      const trimmedContact: ContactInfo = { name: contact.name.trim(), phone: contact.phone.trim(), whatsapp: contact.whatsapp.trim() };
      const hasContact = Boolean(trimmedContact.name || trimmedContact.phone || trimmedContact.whatsapp);
      const hookText = resolvedHookText();
      const trimmedKeyword = ctaKeyword.trim();

      const attributes: Record<string, unknown> = {
        ...fieldAttributes,
        ...(filteredHighlights.length > 0 ? { highlights: filteredHighlights } : {}),
        ...(hasContact ? { contact: trimmedContact } : {}),
        ...(hookText ? { hook: hookText } : {}),
        ...(trimmedKeyword ? { cta_keyword: trimmedKeyword } : {}),
      };

      await Promise.all([
        renameProject(project.id, name.trim() || project.name),
        updateProjectAttributes(project.id, attributes),
      ]);

      const orderedSlotAssets: WizardSlotAsset[] = niche.media_slots
        .filter((slot) => slotAssets[slot.key])
        .map((slot) => ({ slotKey: slot.key, asset: slotAssets[slot.key] }));

      const contactLine = hasContact ? [trimmedContact.name, trimmedContact.phone].filter(Boolean).join(" • ") : null;
      const ctaText =
        niche.cta_template && trimmedKeyword ? interpolateScript(niche.cta_template, { keyword: trimmedKeyword }) : null;

      let narration: TtsOverlay | null = null;
      let narrationWarning: string | null = null;
      if (narrationVoice) {
        setGeneratingStage("Generating narration…");
        const narrationText = resolvedNarrationScript();
        if (narrationText) {
          try {
            const synthesis = await synthesizeTts(project.id, narrationText, narrationVoice);
            // Same real-duration re-probe TtsOverlayDialog does -- the
            // backend's own estimate can drift from the actual mp3 length.
            const durationSeconds = await getAudioDuration(synthesis.url).catch(() => synthesis.durationSeconds);
            narration = {
              text: narrationText,
              voice: narrationVoice,
              assetId: synthesis.assetId,
              durationSeconds,
              wordTimings: synthesis.wordTimings,
              startTimeSeconds: 0,
              // No on-screen caption by default -- the hook/contact/CTA
              // overlays already cover the screen; narration starts as
              // audio-only and can be switched to background/karaoke
              // captions afterward in the editor like any other TTS overlay.
              displayMode: "none",
              rect: DEFAULT_TTS_OVERLAY_RECT,
              templateId: TEXT_TEMPLATE_OPTIONS[0].id,
              volume: 1,
            };
          } catch (err) {
            // Non-fatal: a TTS hiccup (e.g. the daily synthesis cap) shouldn't
            // block the whole reel from being generated -- it just comes out
            // without narration, same as if no voice had been chosen.
            narrationWarning = err instanceof Error ? err.message : "Failed to generate narration";
          }
        }
      }

      let avatarClipAsset: { id: string; url: string } | null = null;
      let avatarWarning: string | null = null;
      if (narration && useAvatarVideo) {
        setGeneratingStage("Generating avatar video… this can take up to a minute");
        try {
          const kicked = await generateAvatarVideo(project.id, narration.assetId, selectedAvatarId || undefined);
          const finalState = await pollAvatarGeneration(kicked.id);
          if (finalState.status === "completed" && finalState.url && finalState.assetId) {
            avatarClipAsset = { id: finalState.assetId, url: finalState.url };
          } else {
            avatarWarning =
              finalState.error ?? "The avatar video didn't finish in time -- used audio-only narration instead.";
          }
        } catch (err) {
          // Non-fatal, same reasoning as the narration try/catch above --
          // falls back to audio-only narration rather than blocking the reel.
          avatarWarning = err instanceof Error ? err.message : "Failed to generate the avatar video";
        }
      }

      setGeneratingStage("Assembling your reel…");
      const selections = await autoAssembleFromWizard(orderedSlotAssets, {
        hookText,
        contactLine,
        ctaText,
        avatarClipAsset,
        narration,
      });

      await saveTimeline(project.id, {
        ...createEmptyReelTimeline(),
        editHistory: [{ label: "Generated by wizard", state: selections, at: Date.now() }],
        editHistoryIndex: 0,
      });

      const warnings = [narrationWarning, avatarWarning].filter((w): w is string => Boolean(w));
      if (warnings.length > 0) {
        window.alert(`Your reel was created, but: ${warnings.join(" ")}`);
      }
      router.push(`/dashboard/${project.id}`);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Failed to generate your reel");
      setGenerating(false);
      setGeneratingStage(null);
    }
  }

  const requiredSlotsFilled =
    !niche || niche.media_slots.filter((slot) => slot.required).every((slot) => Boolean(slotAssets[slot.key]));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-6">
      <WizardProgress steps={STEPS} currentStepId={step} />

      {step === "niche" && (
        <section className="mx-auto flex w-full max-w-sm flex-col gap-3">
          <h1 className="text-xl font-semibold text-foreground">New Reel</h1>
          <p className="text-sm text-muted">
            What kind of business is this reel for? (e.g. real estate, hotel, auto dealership, garment shop, gift
            shop, hardware store — anything works)
          </p>

          {(existingNiches.length > 0 || SUGGESTED_NICHES.length > 0) && (
            <select
              value=""
              onChange={(e) => e.target.value && void submitNiche(e.target.value)}
              disabled={loadingNiche || creatingBlank}
              className={inputClass}
            >
              <option value="">Choose a niche…</option>
              {existingNiches.length > 0 && (
                <optgroup label="Already set up (instant)">
                  {existingNiches.map((n) => (
                    <option key={n.niche_key} value={n.display_name}>
                      {n.display_name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Suggestions">
                {SUGGESTED_NICHES.filter(
                  (name) => !existingNiches.some((n) => n.display_name.toLowerCase() === name.toLowerCase())
                ).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
            </select>
          )}

          <div className="flex items-center gap-2 text-xs text-muted">
            <div className="h-px flex-1 bg-border" />
            or type your own
            <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleNicheSubmit} className="flex flex-col gap-3">
            <input
              placeholder="Business niche"
              value={nicheName}
              onChange={(e) => setNicheName(e.target.value)}
              className={inputClass}
              required
            />
            {nicheError && <p className="text-sm text-red-500">{nicheError}</p>}
            <button type="submit" disabled={loadingNiche || creatingBlank} className={primaryButtonClass}>
              {loadingNiche ? "Setting up…" : "Continue"}
            </button>
          </form>

          <button
            type="button"
            onClick={handleSkipToEditor}
            disabled={loadingNiche || creatingBlank}
            className="text-center text-sm text-muted underline hover:text-foreground disabled:opacity-50"
          >
            {creatingBlank ? "Creating…" : "I'll do it myself — take me to the editor"}
          </button>
        </section>
      )}

      {step === "media" && niche && (
        <section className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground">{niche.display_name}</h1>
            <p className="text-sm text-muted">
              Upload what fits each slot below — a quick guide, not a strict rule. Skip anything optional.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {niche.media_slots.map((slot) => {
              const asset = slotAssets[slot.key];
              const isUploading = Boolean(slotUploading[slot.key]);
              const error = slotError[slot.key];
              return (
                <div key={slot.key} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {slot.label}
                        {slot.required && <span className="ml-1 text-red-500">*</span>}
                      </p>
                      <p className="text-xs text-muted">{slot.hint}</p>
                    </div>
                    {asset && (
                      <button
                        type="button"
                        onClick={() => handleSlotRemove(slot)}
                        className="shrink-0 text-xs text-muted hover:text-foreground hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="mt-2">
                    {asset ? (
                      <div className="flex items-center gap-2">
                        {asset.kind === "image" ? (
                          slotImageSrcById[asset.id] ? (
                            // eslint-disable-next-line @next/next/no-img-element -- a blob: URL from a safe CORS-mode fetch, not a Next-optimizable static asset
                            <img src={slotImageSrcById[asset.id]} alt={asset.filename} className="h-14 w-14 rounded object-cover" />
                          ) : (
                            <div className="flex h-14 w-14 items-center justify-center rounded bg-background text-xs text-muted">
                              …
                            </div>
                          )
                        ) : (
                          <div className="flex h-14 w-14 items-center justify-center rounded bg-background text-xs text-muted">
                            Video
                          </div>
                        )}
                        <p className="truncate text-xs text-muted">{asset.filename}</p>
                      </div>
                    ) : (
                      <>
                        <input
                          type="file"
                          accept={SLOT_UPLOAD_ACCEPT}
                          disabled={isUploading}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (file) void handleSlotFileSelected(slot, file);
                          }}
                          className="text-sm text-muted"
                        />
                        {isUploading && (
                          <div className="mt-1 h-1 w-full max-w-40 overflow-hidden rounded-full bg-border">
                            <div
                              className="h-full rounded-full bg-accent"
                              style={{ width: `${Math.round((slotProgress[slot.key] ?? 0) * 100)}%` }}
                            />
                          </div>
                        )}
                        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" disabled={!requiredSlotsFilled} onClick={() => setStep("details")} className={primaryButtonClass}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === "details" && niche && (
        <section className="flex flex-col gap-3">
          <h1 className="text-xl font-semibold text-foreground">Details</h1>

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

          <div className="flex justify-between gap-2">
            <button type="button" onClick={() => setStep("media")} className={secondaryButtonClass}>
              Back
            </button>
            <button type="button" disabled={!name.trim()} onClick={() => setStep("hook")} className={primaryButtonClass}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === "hook" && niche && (
        <section className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Opening hook</h1>
            <p className="text-sm text-muted">Shown for the first couple of seconds — the line that stops the scroll.</p>
          </div>

          <div className="flex flex-col gap-2">
            {niche.hooks.map((hookTemplate) => {
              const preview = interpolateScript(hookTemplate, currentFieldValues());
              return (
                <label
                  key={hookTemplate}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${
                    selectedHook === hookTemplate ? "border-accent bg-accent/5" : "border-border"
                  }`}
                >
                  <input
                    type="radio"
                    name="hook"
                    checked={selectedHook === hookTemplate}
                    onChange={() => setSelectedHook(hookTemplate)}
                    className="mt-0.5"
                  />
                  <span className="text-foreground">{preview}</span>
                </label>
              );
            })}

            <label
              className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${
                selectedHook === "custom" ? "border-accent bg-accent/5" : "border-border"
              }`}
            >
              <input
                type="radio"
                name="hook"
                checked={selectedHook === "custom"}
                onChange={() => setSelectedHook("custom")}
                className="mt-0.5"
              />
              <span className="flex-1">
                <span className="mb-1 block text-foreground">Write your own</span>
                <input
                  placeholder="Your own opening line"
                  value={customHook}
                  onChange={(e) => {
                    setCustomHook(e.target.value);
                    setSelectedHook("custom");
                  }}
                  className={`${inputClass} w-full`}
                />
              </span>
            </label>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-foreground">Top 3 highlights (optional)</p>
            <div className="flex flex-col gap-2">
              {([0, 1, 2] as const).map((index) => (
                <input
                  key={index}
                  placeholder={`Highlight #${index + 1}`}
                  value={highlights[index]}
                  onChange={(e) => handleHighlightChange(index, e.target.value)}
                  className={inputClass}
                />
              ))}
            </div>
          </div>

          <div className="flex justify-between gap-2">
            <button type="button" onClick={() => setStep("details")} className={secondaryButtonClass}>
              Back
            </button>
            <button type="button" onClick={() => setStep("contact")} className={primaryButtonClass}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === "contact" && niche && (
        <section className="flex flex-col gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Contact & branding</h1>
            <p className="text-sm text-muted">Shown as a lower-third bar throughout the reel. All optional.</p>
          </div>

          <input
            placeholder="Name / business"
            value={contact.name}
            onChange={(e) => setContact((prev) => ({ ...prev, name: e.target.value }))}
            className={inputClass}
          />
          <input
            placeholder="Phone"
            value={contact.phone}
            onChange={(e) => setContact((prev) => ({ ...prev, phone: e.target.value }))}
            className={inputClass}
          />
          <input
            placeholder="WhatsApp (optional, if different)"
            value={contact.whatsapp}
            onChange={(e) => setContact((prev) => ({ ...prev, whatsapp: e.target.value }))}
            className={inputClass}
          />

          {niche.cta_template && (
            <div className="mt-2 rounded-md border border-border p-3">
              <p className="text-sm font-medium text-foreground">End-screen call to action (optional)</p>
              <p className="mb-2 text-xs text-muted">
                A lead-magnet keyword viewers can comment for more info — shown for the last few seconds.
              </p>
              <input
                placeholder="Keyword, e.g. HOME"
                value={ctaKeyword}
                onChange={(e) => setCtaKeyword(e.target.value)}
                className={inputClass}
              />
              {ctaKeyword.trim() && (
                <p className="mt-2 text-sm text-muted">
                  Preview: “{interpolateScript(niche.cta_template, { keyword: ctaKeyword.trim() })}”
                </p>
              )}
            </div>
          )}

          <div className="flex justify-between gap-2">
            <button type="button" onClick={() => setStep("hook")} className={secondaryButtonClass}>
              Back
            </button>
            <button type="button" onClick={() => setStep("review")} className={primaryButtonClass}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === "review" && niche && (
        <section className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Review & generate</h1>
            <p className="text-sm text-muted">
              This builds a real starting reel — every clip, hook, and overlay stays fully editable afterward, where
              you can also choose a free Edge Render or a paid Creatomate render.
            </p>
          </div>

          <dl className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Reel name</dt>
              <dd className="text-right text-foreground">{name || "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Niche</dt>
              <dd className="text-right text-foreground">{niche.display_name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Media</dt>
              <dd className="text-right text-foreground">
                {Object.keys(slotAssets).length} of {niche.media_slots.length} slots
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Hook</dt>
              <dd className="text-right text-foreground">{resolvedHookText() ?? "None"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Contact</dt>
              <dd className="text-right text-foreground">
                {[contact.name, contact.phone].filter(Boolean).join(" • ") || "None"}
              </dd>
            </div>
          </dl>

          {niche.script_template && (
            <div className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium text-foreground">AI voiceover (optional)</p>
              <p className="mb-2 text-xs text-muted">
                Read out over the reel as narration — “{resolvedNarrationScript()}”
              </p>
              <select
                value={narrationVoice}
                onChange={(e) => setNarrationVoice(e.target.value)}
                disabled={loadingNarrationVoices}
                className={inputClass}
              >
                <option value="">No voiceover</option>
                {narrationVoices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label} ({voice.locale})
                  </option>
                ))}
              </select>
              {loadingNarrationVoices && <p className="mt-1 text-xs text-muted">Loading voices…</p>}
              {narrationVoicesError && <p className="mt-1 text-xs text-red-500">{narrationVoicesError}</p>}

              {narrationVoice && (
                <label className="mt-3 flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={useAvatarVideo}
                    onChange={(e) => setUseAvatarVideo(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="text-foreground">Deliver as a talking avatar video</span>
                    <span className="block text-xs text-muted">
                      Opens the reel with a lip-synced avatar speaking the narration, instead of audio only. Takes up
                      to a minute to generate; limited to a few per day.
                    </span>
                  </span>
                </label>
              )}

              {useAvatarVideo && (
                <div className="mt-3">
                  {loadingAvatars && <p className="text-xs text-muted">Loading avatars…</p>}
                  {avatarsError && <p className="text-xs text-red-500">{avatarsError}</p>}
                  {avatarOptions.length > 0 && (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {avatarOptions.map((avatar) => (
                        <label
                          key={avatar.id}
                          className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border p-1.5 ${
                            selectedAvatarId === avatar.id ? "border-accent bg-accent/5" : "border-border"
                          }`}
                        >
                          <input
                            type="radio"
                            name="avatar"
                            checked={selectedAvatarId === avatar.id}
                            onChange={() => setSelectedAvatarId(avatar.id)}
                            className="sr-only"
                          />
                          {avatar.previewImageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- an external HeyGen-hosted thumbnail, not a Next-optimizable static asset
                            <img
                              src={avatar.previewImageUrl}
                              alt={avatar.name}
                              className="aspect-square w-full rounded object-cover"
                            />
                          ) : (
                            <div className="flex aspect-square w-full items-center justify-center rounded bg-background text-xs text-muted">
                              {avatar.name}
                            </div>
                          )}
                          <span className="w-full truncate text-center text-xs text-foreground">{avatar.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {generateError && <p className="text-sm text-red-500">{generateError}</p>}

          <div className="flex justify-between gap-2">
            <button type="button" onClick={() => setStep("contact")} disabled={generating} className={secondaryButtonClass}>
              Back
            </button>
            <button type="button" onClick={handleGenerate} disabled={generating} className={primaryButtonClass}>
              {generating ? (generatingStage ?? "Generating…") : "Generate My Reel"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
