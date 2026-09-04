"use client";

/**
 * "Type a script, pick an avatar, generate a talking-head clip" popup --
 * the desktop editor's own entry point to the same HeyGen avatar pipeline
 * the niche wizard uses (dashboard/(chrome)/new/page.tsx), for adding one
 * to an ALREADY-BUILT reel rather than only at wizard-generation time.
 *
 * Deliberately simpler than TtsOverlayDialog: no positioning rect, no
 * display-mode/template gallery, no separate "generate then add" steps --
 * the result is a real video (with its own baked-in lip-synced audio), not
 * an audio-only overlay needing a caption style, and it's added to the
 * timeline as a normal Video Overlay (Full-Screen/Picture-in-Picture/Split
 * Screen, same as any other video asset -- see AssetGallery's own "Video
 * Overlay" action) once generated, so every existing overlay control
 * (layout switching, framing, deletion) already works on it unchanged.
 * One combined "Generate & add" button reflects that there's no
 * intermediate state worth pausing at (unlike TTS narration, which is
 * worth previewing/re-generating before committing to a script).
 */
import { useEffect, useState } from "react";
import {
  FeatureLockedError,
  generateAvatarVideo,
  listAssets,
  listAvatars,
  listTtsVoices,
  synthesizeTts,
  type Asset,
  type AvatarOption,
  type TtsVoiceOption,
} from "@/lib/api";
import { pollAvatarGeneration } from "@/lib/avatarGeneration";
import { usePermissions } from "@/lib/usePermissions";
import { UpgradeRequiredDialog } from "@/components/UpgradeRequiredDialog";
import { TransliterateTextarea } from "@/components/TransliterateField";

export function TtsAvatarDialog({
  projectId,
  onGenerated,
  onClose,
}: {
  projectId: string;
  // Hands back the fully-resolved Asset (not just an id) once the avatar
  // video is generated AND already appears in listAssets(projectId) -- the
  // caller (ThreePaneEditor) can add it as a video overlay immediately,
  // with no separate "wait for the asset list to catch up" step.
  onGenerated: (asset: Asset) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("");
  const [voices, setVoices] = useState<TtsVoiceOption[]>([]);
  const [isLoadingVoices, setIsLoadingVoices] = useState(true);
  const [voicesError, setVoicesError] = useState<string | null>(null);

  const [avatarId, setAvatarId] = useState("");
  const [avatars, setAvatars] = useState<AvatarOption[]>([]);
  const [isLoadingAvatars, setIsLoadingAvatars] = useState(true);
  const [avatarsError, setAvatarsError] = useState<string | null>(null);

  const [isGenerating, setIsGenerating] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lockedError, setLockedError] = useState<FeatureLockedError | null>(null);

  // Proactive-but-not-authoritative hint -- real enforcement is
  // require_feature("tts_synthesize"/"avatar_generate") on the backend; see
  // this dialog's own catch below for what actually happens if it's denied.
  const { loading: isLoadingPermissions, has: hasFeature } = usePermissions();
  const canGenerateAvatar = isLoadingPermissions || (hasFeature("tts_synthesize") && hasFeature("avatar_generate"));

  useEffect(() => {
    let cancelled = false;
    listTtsVoices()
      .then((res) => {
        if (cancelled) return;
        setVoices(res.voices);
        setVoice((prev) => prev || res.voices[0]?.id || "");
      })
      .catch((err) => {
        if (!cancelled) setVoicesError(err instanceof Error ? err.message : "Failed to load voices");
      })
      .finally(() => {
        if (!cancelled) setIsLoadingVoices(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listAvatars()
      .then((res) => {
        if (cancelled) return;
        setAvatars(res.avatars);
        setAvatarId((prev) => prev || res.avatars[0]?.id || "");
      })
      .catch((err) => {
        if (!cancelled) setAvatarsError(err instanceof Error ? err.message : "Failed to load avatars");
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAvatars(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmedText = text.trim();
  const canGenerate = Boolean(trimmedText && voice && avatarId) && !isGenerating;

  async function handleGenerate() {
    if (!canGenerate) return;
    setIsGenerating(true);
    setError(null);
    try {
      setStage("Generating narration…");
      const synthesis = await synthesizeTts(projectId, trimmedText, voice);

      setStage("Generating avatar video… this can take up to a minute");
      const kicked = await generateAvatarVideo(projectId, synthesis.assetId, avatarId);
      const finalState = await pollAvatarGeneration(kicked.id);
      if (finalState.status !== "completed" || !finalState.assetId) {
        throw new Error(finalState.error ?? "Avatar video didn't finish in time -- try again");
      }

      setStage("Adding to your reel…");
      const projectAssets = await listAssets(projectId);
      const asset = projectAssets.find((a) => a.id === finalState.assetId);
      if (!asset) throw new Error("Generated video wasn't found in this project's assets");

      onGenerated(asset);
    } catch (err) {
      if (err instanceof FeatureLockedError) setLockedError(err);
      else setError(err instanceof Error ? err.message : "Failed to generate the avatar video");
    } finally {
      setIsGenerating(false);
      setStage(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="TTS + Avatar"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="text-sm font-semibold">TTS + Avatar</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="shrink-0 text-[11px] text-muted">
          Generates a talking-avatar video reading your script, then adds it as a Video Overlay you can position
          and switch layouts on like any other.
        </p>

        {/* shrink-0 -- a flex column shrinks every child proportionally by
            default once total content exceeds max-h-[85vh], which was
            squeezing this below its own 3-row height. The avatar section
            below is the one part that should actually flex/scroll instead
            of this. */}
        <TransliterateTextarea
          value={text}
          onChange={setText}
          locale={voices.find((option) => option.id === voice)?.locale ?? null}
          placeholder="Type what the avatar should say…"
          rows={3}
          className="w-full shrink-0 resize-none rounded-md border border-border bg-background px-2 py-1 text-sm"
        />

        <label className="flex shrink-0 flex-col gap-1 text-xs text-muted">
          Voice
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            disabled={isLoadingVoices || voices.length === 0}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground disabled:opacity-50"
          >
            {voices.length === 0 && <option value="">{isLoadingVoices ? "Loading voices…" : "No voices available"}</option>}
            {voices.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} ({option.locale})
              </option>
            ))}
          </select>
        </label>
        {voicesError && <p className="shrink-0 text-[11px] text-red-600">{voicesError}</p>}

        {/* The one flexible/scrollable section -- grows to fill whatever
            space the fixed rows above/below leave, and scrolls internally
            once the avatar grid outgrows that, rather than shrinking
            everything else on the page. */}
        <div className="flex min-h-0 flex-1 flex-col gap-1">
          <p className="shrink-0 text-xs text-muted">Your avatars</p>
          {isLoadingAvatars && <p className="shrink-0 text-xs text-muted">Loading avatars…</p>}
          {avatarsError && <p className="shrink-0 text-xs text-red-600">{avatarsError}</p>}
          {!isLoadingAvatars && !avatarsError && avatars.length === 0 && (
            <p className="shrink-0 text-xs text-muted">
              No avatars found on your HeyGen account yet -- create one at heygen.com first.
            </p>
          )}
          {avatars.length > 0 && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="grid grid-cols-4 gap-2">
                {avatars.map((avatar) => (
                  <label
                    key={avatar.id}
                    className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border p-1.5 ${
                      avatarId === avatar.id ? "border-violet-500 bg-violet-500/10" : "border-border"
                    }`}
                  >
                    <input
                      type="radio"
                      name="avatar"
                      checked={avatarId === avatar.id}
                      onChange={() => setAvatarId(avatar.id)}
                      className="sr-only"
                    />
                    {avatar.previewImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- an external HeyGen-hosted thumbnail, not a Next-optimizable static asset
                      <img src={avatar.previewImageUrl} alt={avatar.name} className="aspect-square w-full rounded object-cover" />
                    ) : (
                      <div className="flex aspect-square w-full items-center justify-center rounded bg-background text-xs text-muted">
                        {avatar.name}
                      </div>
                    )}
                    <span className="w-full truncate text-center text-[10px] text-foreground">{avatar.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {error && <p className="shrink-0 text-[11px] text-red-600">{error}</p>}

        <button
          type="button"
          onClick={handleGenerate}
          disabled={!canGenerate}
          className="mt-1 flex w-full shrink-0 items-center justify-center gap-1.5 rounded-md bg-violet-600 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {isGenerating ? (stage ?? "Generating…") : "Generate & add"}
          {!isGenerating && !canGenerateAvatar && (
            <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase">Pro</span>
          )}
        </button>
      </div>
      {lockedError && <UpgradeRequiredDialog error={lockedError} onClose={() => setLockedError(null)} />}
    </div>
  );
}
