"use client";

/**
 * "Type a script, generate speech, caption it" popup for TTS narration --
 * clones TextOverlayDialog.tsx's own split-pane shape (see that file's
 * module comment) but carries a lot more state, since a narration overlay
 * needs a synthesis round-trip before it's even addable, not just typed
 * text. Used both for adding a new overlay (editingOverlay is null) and for
 * editing an existing one's script/voice/mode/template/position (pre-filled,
 * reopened from ActionArea's ActiveTransformationsList).
 *
 * Left half: same live frame preview + draggable/resizable rect overlay as
 * TextOverlayDialog. Background mode reuses TextOverlayCanvas (the exact
 * template renderer CanvasPlayer uses for live playback -- see
 * lib/video/textTemplates.ts) so the preview is pixel-consistent with what
 * actually plays; karaoke mode gets a simpler static preview (the typed
 * text in a plain highlighted style) rather than simulating word timing in
 * a dialog nobody watches play through -- CanvasPlayer's own live preview is
 * where the real word-by-word highlight actually needs to be accurate (see
 * that file's own karaoke renderer).
 *
 * Right half: script textarea, a voice <select> (fetched from
 * listTtsVoices() on mount), a Background/Karaoke/No-text segmented toggle, the
 * same TEXT_TEMPLATE_OPTIONS gallery TextOverlayDialog uses (styles the
 * caption in background mode, and karaoke's base look too), a "Generate
 * speech" button, and an <audio controls> preview of whatever's currently
 * synthesized. Deliberately no rate/pitch sliders -- the backend supports
 * them, but a text + voice + mode + template picker is already a lot for
 * one dialog (see this app's root CLAUDE.md "Driving vision": simple,
 * direct-manipulation controls over exposing every knob); rate/pitch are
 * sent as 0 (their documented default) always.
 *
 * "Add"/"Save" is disabled until `synthesis` matches the CURRENTLY typed
 * text exactly (`synthesizedText === text.trim()`) -- true immediately after
 * a successful "Generate speech", and pre-seeded true when reopening an
 * unedited existing overlay (editingOverlayAssetUrl lets this dialog show
 * that overlay's already-generated audio without re-synthesizing it), false
 * again the moment the script is edited away from what was last generated.
 */
import { useEffect, useState } from "react";
import { TEXT_TEMPLATE_OPTIONS, type TextTemplateId } from "@/lib/video/textTemplates";
import { TextOverlayCanvas } from "./TextOverlayCanvas";
import { OverlayRectOverlay } from "./OverlayRectOverlay";
import { DEFAULT_TTS_OVERLAY_RECT, type CropRect, type TtsOverlay, type TtsWordTiming } from "@/lib/video/video_math";
import { listTtsVoices, synthesizeTts, type TtsVoiceOption } from "@/lib/api";

const PREVIEW_PROGRESS = 0.6;
const DEFAULT_PREVIEW_TEXT = "Your narration here";

interface SynthesisResult {
  assetId: string;
  url: string;
  durationSeconds: number;
  wordTimings: TtsWordTiming[];
}

export function TtsOverlayDialog({
  projectId,
  editingOverlay,
  editingOverlayAssetUrl,
  previewFrameUrl,
  frameAspectRatio,
  currentTimeSeconds,
  onSave,
  onClose,
}: {
  projectId: string;
  editingOverlay: TtsOverlay | null;
  // The already-generated audio's own presigned URL, resolved by the caller
  // (assetUrlById[editingOverlay.assetId]) -- TtsOverlay itself carries no
  // URL (only assetId, same convention as every other overlay type), and
  // this dialog needs a playable URL to preload `synthesis` from when
  // editing (so re-opening an unedited overlay doesn't force a re-synthesis)
  // and to power its own <audio controls> preview. Null while that asset
  // hasn't resolved yet (or there's nothing being edited).
  editingOverlayAssetUrl: string | null;
  previewFrameUrl: string | null;
  frameAspectRatio: number | null;
  // Used as a freshly-added overlay's startTimeSeconds -- an existing
  // overlay keeps its own (see handleSave).
  currentTimeSeconds: number;
  onSave: (overlay: TtsOverlay) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(editingOverlay?.text ?? "");
  const [voice, setVoice] = useState(editingOverlay?.voice ?? "");
  const [displayMode, setDisplayMode] = useState<"background" | "karaoke" | "none">(editingOverlay?.displayMode ?? "background");
  const [templateId, setTemplateId] = useState<TextTemplateId>(
    (editingOverlay?.templateId as TextTemplateId) ?? TEXT_TEMPLATE_OPTIONS[0].id
  );
  const [rect, setRect] = useState<CropRect>(editingOverlay?.rect ?? DEFAULT_TTS_OVERLAY_RECT);
  // TtsOverlayTrack (FrameStrip.tsx) is the direct-manipulation way to move
  // a narration's start time after it's been added (drag its segment); this
  // plain seconds input is still here as the precise/keyboard-only way to
  // do the same thing from inside the dialog itself, same as every other
  // overlay dialog's own numeric fields alongside their track's drag
  // handles.
  const [startTimeSeconds, setStartTimeSeconds] = useState(editingOverlay?.startTimeSeconds ?? currentTimeSeconds);

  const [voices, setVoices] = useState<TtsVoiceOption[]>([]);
  const [isLoadingVoices, setIsLoadingVoices] = useState(true);
  const [voicesError, setVoicesError] = useState<string | null>(null);

  // The synthesis currently backing "Add"/"Save", and the exact script text
  // it was generated from -- Save is only enabled while these match the
  // live `text` state (see this file's own module comment). Pre-seeded from
  // editingOverlay so reopening an unedited overlay doesn't need a fresh
  // synthesis call.
  const [synthesis, setSynthesis] = useState<SynthesisResult | null>(
    editingOverlay && editingOverlayAssetUrl
      ? {
          assetId: editingOverlay.assetId,
          url: editingOverlayAssetUrl,
          durationSeconds: editingOverlay.durationSeconds,
          wordTimings: editingOverlay.wordTimings,
        }
      : null
  );
  const [synthesizedText, setSynthesizedText] = useState<string | null>(
    editingOverlay && editingOverlayAssetUrl ? editingOverlay.text : null
  );
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [synthesisError, setSynthesisError] = useState<string | null>(null);

  // Re-syncs if a different overlay is opened for editing (or the dialog is
  // reopened fresh for "Add") while already mounted -- same convention as
  // TextOverlayDialog's own effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(editingOverlay?.text ?? "");
    setVoice((prev) => editingOverlay?.voice ?? prev);
    setDisplayMode(editingOverlay?.displayMode ?? "background");
    setTemplateId((editingOverlay?.templateId as TextTemplateId) ?? TEXT_TEMPLATE_OPTIONS[0].id);
    setRect(editingOverlay?.rect ?? DEFAULT_TTS_OVERLAY_RECT);
    setStartTimeSeconds(editingOverlay?.startTimeSeconds ?? currentTimeSeconds);
    setSynthesis(
      editingOverlay && editingOverlayAssetUrl
        ? {
            assetId: editingOverlay.assetId,
            url: editingOverlayAssetUrl,
            durationSeconds: editingOverlay.durationSeconds,
            wordTimings: editingOverlay.wordTimings,
          }
        : null
    );
    setSynthesizedText(editingOverlay && editingOverlayAssetUrl ? editingOverlay.text : null);
    setSynthesisError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editingOverlayAssetUrl is a fresh lookup every render; editingOverlay's own identity is what actually gates a re-sync
  }, [editingOverlay]);

  useEffect(() => {
    let cancelled = false;
    // No setIsLoadingVoices(true) here -- the state already starts `true`
    // (see its useState above) and this effect only ever runs once (empty
    // deps), so there's nothing to reset back to loading.
    listTtsVoices()
      .then((res) => {
        if (cancelled) return;
        setVoices(res.voices);
        setVoicesError(null);
        // Defaults to the first available voice once the catalog loads --
        // doesn't override a voice already chosen (a fresh "Add" with none
        // picked yet, or an editingOverlay's own voice pre-filled above).
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

  async function handleGenerateSpeech() {
    const trimmed = text.trim();
    if (!trimmed || !voice || isSynthesizing) return;
    setIsSynthesizing(true);
    setSynthesisError(null);
    try {
      const result = await synthesizeTts(projectId, trimmed, voice);
      setSynthesis(result);
      setSynthesizedText(trimmed);
    } catch (err) {
      setSynthesisError(err instanceof Error ? err.message : "Failed to generate speech");
    } finally {
      setIsSynthesizing(false);
    }
  }

  const trimmedText = text.trim();
  const canSave = Boolean(synthesis) && synthesizedText === trimmedText;

  function handleSave() {
    if (!canSave || !synthesis) return;
    const overlay: TtsOverlay = {
      text: trimmedText,
      voice,
      assetId: synthesis.assetId,
      durationSeconds: synthesis.durationSeconds,
      wordTimings: synthesis.wordTimings,
      startTimeSeconds: Math.max(startTimeSeconds, 0),
      displayMode,
      rect,
      templateId,
      volume: editingOverlay?.volume ?? 1,
    };
    onSave(overlay);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editingOverlay ? "Edit narration" : "Add narration"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{editingOverlay ? "Edit narration" : "Add narration"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto sm:flex-row">
          {/* Left half: the real frame, with the caption's rect draggable
              directly on top of it -- same as TextOverlayDialog. */}
          <div className="flex flex-col gap-1.5 sm:w-1/2">
            <div
              className="relative w-full overflow-hidden rounded-md bg-black"
              style={frameAspectRatio ? { aspectRatio: `${frameAspectRatio}` } : { minHeight: "12rem" }}
            >
              {previewFrameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset
                <img src={previewFrameUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : (
                <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                  No frame preview yet -- add a video first
                </p>
              )}
              {/* "None" has no caption to position, so no draggable rect
                  either -- just the frame itself with a small notice, rather
                  than a rect handle that would drag nothing. */}
              {displayMode === "none" ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-2 text-center text-xs text-white/80">
                  Narration plays as audio only -- no text will be shown.
                </div>
              ) : (
                <OverlayRectOverlay
                  rect={rect}
                  onChange={setRect}
                  onCommit={setRect}
                  borderColorClassName="border-violet-400"
                  handleColorClassName="bg-violet-400"
                  renderInner={
                    displayMode === "background" ? (
                      <TextOverlayCanvas
                        text={text.trim() || DEFAULT_PREVIEW_TEXT}
                        templateId={templateId}
                        progress={PREVIEW_PROGRESS}
                        className="h-full w-full"
                      />
                    ) : (
                      // Karaoke's live word-by-word highlight only matters
                      // during real playback (see CanvasPlayer.tsx) -- this
                      // dialog just shows a plain static preview of the text
                      // itself, not a simulated word-timing animation.
                      <div className="flex h-full w-full items-center justify-center bg-black/60 p-2 text-center">
                        <span className="rounded bg-violet-400/90 px-1 py-0.5 text-sm font-bold text-black">
                          {(text.trim() || DEFAULT_PREVIEW_TEXT).split(/\s+/)[0]}
                        </span>
                        <span className="ml-1 text-sm font-bold text-white">
                          {text.trim() ? text.trim().split(/\s+/).slice(1).join(" ") : DEFAULT_PREVIEW_TEXT.split(/\s+/).slice(1).join(" ")}
                        </span>
                      </div>
                    )
                  }
                />
              )}
            </div>
            <p className="text-[11px] text-muted">
              {displayMode === "none" ? "Narration plays with no on-screen caption." : "Drag to position, drag the corner to resize."}
            </p>
          </div>

          {/* Right half: script + voice + mode + template gallery. */}
          <div className="flex min-h-0 flex-1 flex-col sm:w-1/2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type what the narrator should say…"
              rows={3}
              className="mb-2 w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-sm"
            />

            <label className="mb-2 flex flex-col gap-1 text-xs text-muted">
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
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {voicesError && <p className="mb-2 text-[11px] text-red-600">{voicesError}</p>}

            <label className="mb-2 flex items-center gap-2 text-xs text-muted">
              Starts at
              <input
                type="number"
                min={0}
                step={0.1}
                value={startTimeSeconds}
                onChange={(e) => setStartTimeSeconds(Math.max(Number(e.target.value) || 0, 0))}
                className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
              />
              seconds
            </label>

            {/* Background text / Karaoke captions / No Text segmented toggle. */}
            <div className="mb-2 flex overflow-hidden rounded-md border border-border text-xs">
              <button
                type="button"
                onClick={() => setDisplayMode("background")}
                className={`flex-1 py-1 font-medium ${displayMode === "background" ? "bg-accent text-accent-foreground" : "bg-background text-muted hover:text-foreground"}`}
              >
                Background text
              </button>
              <button
                type="button"
                onClick={() => setDisplayMode("karaoke")}
                className={`flex-1 py-1 font-medium ${displayMode === "karaoke" ? "bg-accent text-accent-foreground" : "bg-background text-muted hover:text-foreground"}`}
              >
                Karaoke captions
              </button>
              <button
                type="button"
                onClick={() => setDisplayMode("none")}
                title="Narration plays as audio only, with no text shown on screen"
                className={`flex-1 py-1 font-medium ${displayMode === "none" ? "bg-accent text-accent-foreground" : "bg-background text-muted hover:text-foreground"}`}
              >
                No text
              </button>
            </div>

            <div className="mb-2 flex items-center gap-2">
              <button
                type="button"
                onClick={handleGenerateSpeech}
                disabled={!trimmedText || !voice || isSynthesizing}
                className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {isSynthesizing ? "Generating…" : "Generate speech"}
              </button>
              {canSave && <span className="text-[11px] text-green-600">Speech ready ({synthesis?.durationSeconds.toFixed(1)}s)</span>}
            </div>
            {synthesisError && <p className="mb-2 text-[11px] text-red-600">{synthesisError}</p>}
            {synthesis && (
              <audio controls src={synthesis.url} className="mb-2 h-8 w-full">
                Your browser does not support the audio element.
              </audio>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="grid grid-cols-2 gap-2">
                {TEXT_TEMPLATE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setTemplateId(option.id)}
                    className={
                      "flex flex-col overflow-hidden rounded-md border-2 " +
                      (templateId === option.id ? "border-accent" : "border-transparent")
                    }
                  >
                    <TextOverlayCanvas
                      text={text.trim() || DEFAULT_PREVIEW_TEXT}
                      templateId={option.id}
                      progress={PREVIEW_PROGRESS}
                      className="aspect-video w-full bg-neutral-900"
                    />
                    <span className="bg-background px-1 py-0.5 text-center text-[10px] text-foreground">{option.name}</span>
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              title={!canSave ? "Generate speech for the current script first" : undefined}
              className="mt-3 w-full rounded-md bg-accent py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              {editingOverlay ? "Save" : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
