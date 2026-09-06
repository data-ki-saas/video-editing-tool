"use client";

/**
 * Full-screen live camera capture -- opened from TopMenuBar's Record button
 * (right after the Cover thumbnail) and AssetGallery/MobileAssetStrip's own
 * "+ Record"/"Record" action, at dashboard/[projectId]/record. Works the
 * same way on desktop (webcam) and mobile (front/back switch): one
 * `<video>` reads the live camera+mic stream, one `<canvas>` redraws it
 * every frame with whatever Filter/Ambience/Face effect is picked baked in
 * -- that composited canvas is simultaneously what the user sees, what gets
 * recorded, and what a snapshot grabs, so preview/record/snap never drift
 * from each other.
 *
 * Filters (filterPresets.ts) and Ambience (ambientEffects.ts) are reused
 * completely unchanged from the editor's own Ken-Burns-cutaway effects --
 * both are already pure functions of a 2D canvas context. Face effect
 * (Torus/Halo, faceLandmarks.ts + camera3D.ts) needed one new piece: a live
 * VIDEO-mode MediaPipe detector (detectFaceGeometryForVideoFrame), since the
 * existing one only ever analyzed a single still photo once. "Make it 3D"
 * itself (the dolly/pan/tilt camera move) has no live-camera equivalent --
 * it's a virtual camera move over a static plane, meaningless for a real
 * handheld feed -- so it's deliberately not offered here.
 *
 * Recording uses MediaRecorder against `canvas.captureStream(24)` (plus the
 * camera stream's own mic audio track) rather than driving mediabunny/
 * WebCodecs directly -- MediaRecorder already gives synchronized audio+video
 * capture with native pause()/resume() on every major browser for free.
 * Whatever container MediaRecorder actually produces (webm almost
 * everywhere, mp4 natively on Safari) gets converted to `video/mp4` before
 * upload via lib/media/cameraRecording.ts's toMp4Asset, since backend/src/
 * assets/service.py's allow-list only accepts mp4 video.
 *
 * Saves into this PROJECT's own asset library (POST /api/assets, the same
 * gallery AssetGallery.tsx shows) rather than the separate finished-renders
 * /library page -- a recording is raw footage to edit with, not a finished
 * reel.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadAssetWithProgress } from "@/lib/api";
import { ReelLoader } from "@/components/ReelLoader";
import { FILTER_PRESET_OPTIONS, getFilterPresetOption, type FilterPresetId } from "@/lib/video/filterPresets";
import { AMBIENT_EFFECT_OPTIONS, ambientEffectSeed, drawAmbientEffect, type AmbientEffectId } from "@/lib/video/ambientEffects";
import { FACE_EFFECT_OPTIONS, detectFaceGeometryForVideoFrame, type FaceEffectId, type FaceGeometry } from "@/lib/video/faceLandmarks";
import { segmentVideoFrameApproximate } from "@/lib/video/backgroundSegmentation";
import { Camera3DRenderer, NEUTRAL_POSE } from "@/lib/video/camera3D";
import { pickMediaRecorderMimeType, toMp4Asset } from "@/lib/media/cameraRecording";
import { FlipCameraIcon, PlayIcon, PauseIcon } from "./icons/PlayerIcons";

const MAX_RECORDING_SECONDS = 180;
const FACE_DETECT_INTERVAL_MS = 150;
// Heavier than face-landmark detection (a full selfie-segmentation model
// pass, not just landmark math), and only ever needed for "halo" -- see
// segmentVideoFrameApproximate's own doc comment -- so throttled coarser.
const SUBJECT_CUTOUT_INTERVAL_MS = 200;
const TARGET_FPS = 24;
const TIMER_TICK_MS = 250;

type RecorderState = "idle" | "recording" | "paused";
type EffectPicker = "filter" | "ambience" | "face" | null;

function formatTimer(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function describeCameraError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "Camera access was denied. Allow camera (and microphone) access in your browser's site settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device.";
  return "Couldn't access the camera. Check your browser's permission settings and try again.";
}

function stopMediaRecorder(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === "inactive") return Promise.resolve();
  return new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.stop();
  });
}

function PillRow<T extends string>({
  options,
  selectedId,
  onSelect,
}: {
  options: { id: T; label: string }[];
  selectedId: T | null;
  onSelect: (id: T | null) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`shrink-0 rounded-full border px-3 py-1 text-xs ${
          selectedId === null ? "border-accent bg-accent text-accent-foreground" : "border-white/30 text-white"
        }`}
      >
        None
      </button>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onSelect(option.id)}
          className={`shrink-0 rounded-full border px-3 py-1 text-xs ${
            selectedId === option.id ? "border-accent bg-accent text-accent-foreground" : "border-white/30 text-white"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function CameraCapturePage({ projectId }: { projectId: string }) {
  const router = useRouter();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const camera3DRendererRef = useRef<Camera3DRenderer | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const sessionStartMsRef = useRef<number>(performance.now());
  const accumulatedRecordedMsRef = useRef(0);
  const segmentStartMsRef = useRef(0);
  const lastFaceDetectAtRef = useRef(0);
  const liveFaceGeometryRef = useRef<FaceGeometry | null>(null);
  const lastSubjectCutoutAtRef = useRef(0);
  const liveSubjectCutoutRef = useRef<ImageBitmap | null>(null);
  // Guards against handleStop running twice concurrently -- e.g. the
  // 3-minute cap firing in the same tick the user taps "Finish".
  const isStoppingRef = useRef(false);

  const [facingMode, setFacingMode] = useState<"user" | "environment">("environment");
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  // Bumped by the "Try again" button to force the camera-acquisition effect
  // below to re-run even when facingMode hasn't changed (setting it to its
  // own value wouldn't re-trigger the effect).
  const [retryToken, setRetryToken] = useState(0);

  const [recorderState, setRecorderState] = useState<RecorderState>("idle");
  const [recordedMs, setRecordedMs] = useState(0);
  const [capWarning, setCapWarning] = useState(false);

  const [filterId, setFilterId] = useState<FilterPresetId | null>(null);
  const [ambientEffectId, setAmbientEffectId] = useState<AmbientEffectId | null>(null);
  const [faceEffectId, setFaceEffectId] = useState<FaceEffectId | null>(null);
  const [openPicker, setOpenPicker] = useState<EffectPicker>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Read by the rAF draw loop below without needing to restart it (and thus
  // re-create the camera/renderer) every time an effect toggle changes --
  // same lightweight "assign during render" ref-mirroring as several other
  // editor-v2 components already use for values a rAF loop reads live.
  const filterIdRef = useRef(filterId);
  filterIdRef.current = filterId;
  const ambientEffectIdRef = useRef(ambientEffectId);
  ambientEffectIdRef.current = ambientEffectId;
  const faceEffectIdRef = useRef(faceEffectId);
  faceEffectIdRef.current = faceEffectId;

  function getCamera3DRenderer(): Camera3DRenderer {
    if (!camera3DRendererRef.current) camera3DRendererRef.current = new Camera3DRenderer();
    return camera3DRendererRef.current;
  }

  // Acquires (and re-acquires on camera flip) the camera+mic stream.
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change (facingMode/retryToken), same pattern as CutawayDialog's own re-sync effects
    setCameraError(null);

    navigator.mediaDevices
      .getUserMedia({
        audio: true,
        video: {
          facingMode,
          width: { ideal: 720 },
          height: { ideal: 1280 },
          aspectRatio: { ideal: 9 / 16 },
          frameRate: { ideal: TARGET_FPS, max: TARGET_FPS },
        },
      })
      .then(async (mediaStream) => {
        if (cancelled) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = mediaStream;
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          try {
            await videoRef.current.play();
          } catch {
            // Autoplay can be blocked without a preceding user gesture on
            // some browsers -- this page is only ever reached via a click,
            // so this is a rare, non-fatal edge case; the video stays
            // paused-on-first-frame at worst.
          }
        }
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) setHasMultipleCameras(devices.filter((d) => d.kind === "videoinput").length > 1);
        } catch {
          // Device labels/enumeration can fail before permission is fully
          // settled on some browsers -- just keep the flip button hidden.
        }
      })
      .catch((err) => {
        if (!cancelled) setCameraError(describeCameraError(err));
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [facingMode, retryToken]);

  // The compositing loop -- redraws the live camera frame onto the visible
  // canvas every rAF tick, with the current filter/ambience/face effect
  // baked in. This canvas is what's shown, what MediaRecorder captures, and
  // what a snapshot reads -- one pipeline for all three, so none of them can
  // drift from what the user is actually looking at.
  useEffect(() => {
    let cancelled = false;

    function draw() {
      if (cancelled) return;
      rafIdRef.current = requestAnimationFrame(draw);

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2 || video.videoWidth === 0) return;

      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const elapsedSeconds = (performance.now() - sessionStartMsRef.current) / 1000;
      const currentFaceEffect = faceEffectIdRef.current;
      const currentAmbientEffect = ambientEffectIdRef.current;

      ctx.filter = getFilterPresetOption(filterIdRef.current).cssFilter;
      if (currentFaceEffect) {
        getCamera3DRenderer().drawImage3D(
          ctx, video, NEUTRAL_POSE, 0, 0, video.videoWidth, video.videoHeight, 0, 0, canvas.width, canvas.height, false, false,
          currentAmbientEffect ? { effectId: currentAmbientEffect, elapsedSeconds, seed: ambientEffectSeed(projectId) } : null,
          currentFaceEffect === "halo" ? liveSubjectCutoutRef.current : null,
          liveFaceGeometryRef.current ? { effectId: currentFaceEffect, geometry: liveFaceGeometryRef.current, elapsedSeconds } : null
        );
      } else {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.filter = "none";
        if (currentAmbientEffect) {
          drawAmbientEffect(ctx, currentAmbientEffect, 0, 0, canvas.width, canvas.height, elapsedSeconds, ambientEffectSeed(projectId));
        }
      }
      ctx.filter = "none";

      // Throttled live face detection -- only worth running at all while a
      // face effect is actually picked, and even then MediaPipe's own
      // per-call cost doesn't need to be paid every single frame for a
      // slowly-drifting head-locked glow (see detectFaceGeometryForVideoFrame's
      // own doc comment).
      if (currentFaceEffect) {
        const now = performance.now();
        if (now - lastFaceDetectAtRef.current > FACE_DETECT_INTERVAL_MS) {
          lastFaceDetectAtRef.current = now;
          detectFaceGeometryForVideoFrame(video, now).then((geometry) => {
            liveFaceGeometryRef.current = geometry;
          });
        }
      } else {
        liveFaceGeometryRef.current = null;
      }

      // Only "halo" needs a subject cutout to occlude it -- see
      // segmentVideoFrameApproximate's own doc comment -- so this heavier
      // segmentation pass never runs for "torus" or no face effect at all.
      if (currentFaceEffect === "halo") {
        const now = performance.now();
        if (now - lastSubjectCutoutAtRef.current > SUBJECT_CUTOUT_INTERVAL_MS) {
          lastSubjectCutoutAtRef.current = now;
          segmentVideoFrameApproximate(video, now).then((bitmap) => {
            liveSubjectCutoutRef.current?.close();
            liveSubjectCutoutRef.current = bitmap;
          });
        }
      } else if (liveSubjectCutoutRef.current) {
        liveSubjectCutoutRef.current.close();
        liveSubjectCutoutRef.current = null;
      }
    }

    rafIdRef.current = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, [projectId]);

  // Disposes the (lazily created) Camera3DRenderer, and makes sure a
  // still-running MediaRecorder is stopped, when this page unmounts (e.g.
  // navigating away without tapping Stop/Done).
  useEffect(() => {
    return () => {
      camera3DRendererRef.current?.dispose();
      liveSubjectCutoutRef.current?.close();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
    };
  }, []);

  // The visible timer + the actual 3-minute cap -- ticks only while
  // genuinely recording (not paused), a coarser 250ms cadence than the draw
  // loop above since neither the on-screen timer nor a 3-minute cap need
  // per-frame precision.
  useEffect(() => {
    if (recorderState !== "recording") return;
    const interval = setInterval(() => {
      const liveMs = accumulatedRecordedMsRef.current + (performance.now() - segmentStartMsRef.current);
      setRecordedMs(liveMs);
      if (liveMs >= MAX_RECORDING_SECONDS * 1000) {
        setCapWarning(true);
        void handleStop();
      }
    }, TIMER_TICK_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleStop is stable enough here (reads refs/latest state internally); re-running this effect on every render would restart the interval needlessly
  }, [recorderState]);

  function handleFlipCamera() {
    setFacingMode((prev) => (prev === "user" ? "environment" : "user"));
  }

  function handleStartOrResume() {
    if (recorderState === "idle") {
      const canvas = canvasRef.current;
      const mimeType = pickMediaRecorderMimeType();
      if (!canvas || !mimeType) {
        setSaveError("This browser can't record video.");
        return;
      }
      const canvasStream = canvas.captureStream(TARGET_FPS);
      const audioTrack = streamRef.current?.getAudioTracks()[0];
      if (audioTrack) canvasStream.addTrack(audioTrack);

      const recorder = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: 2_500_000 });
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      accumulatedRecordedMsRef.current = 0;
      segmentStartMsRef.current = performance.now();
      setRecordedMs(0);
      setCapWarning(false);
      setRecorderState("recording");
    } else if (recorderState === "paused") {
      mediaRecorderRef.current?.resume();
      segmentStartMsRef.current = performance.now();
      setRecorderState("recording");
    }
  }

  function handlePause() {
    if (recorderState !== "recording") return;
    accumulatedRecordedMsRef.current += performance.now() - segmentStartMsRef.current;
    mediaRecorderRef.current?.pause();
    setRecorderState("paused");
  }

  async function handleStop() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorderState === "idle" || isStoppingRef.current) return;
    isStoppingRef.current = true;
    if (recorderState === "recording") {
      accumulatedRecordedMsRef.current += performance.now() - segmentStartMsRef.current;
    }
    setRecorderState("idle");
    await stopMediaRecorder(recorder);

    setIsProcessing(true);
    setSaveError(null);
    try {
      setProcessingStage("Preparing your recording…");
      const rawBlob = new Blob(recordedChunksRef.current, { type: recorder.mimeType });
      const file = await toMp4Asset(rawBlob, `recording-${Date.now()}.mp4`);
      setProcessingStage("Saving to your assets…");
      await uploadAssetWithProgress(projectId, file, (fraction) =>
        setProcessingStage(`Saving to your assets… ${Math.round(fraction * 100)}%`)
      );
      router.push(`/dashboard/${projectId}`);
    } catch (err) {
      setIsProcessing(false);
      setSaveError(err instanceof Error ? err.message : "Failed to save this recording");
    }
  }

  async function handleSnapPhoto() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setIsProcessing(true);
    setSaveError(null);
    setProcessingStage("Saving to your assets…");
    try {
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("Couldn't capture a photo");
      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
      await uploadAssetWithProgress(projectId, file, (fraction) =>
        setProcessingStage(`Saving to your assets… ${Math.round(fraction * 100)}%`)
      );
      router.push(`/dashboard/${projectId}`);
    } catch (err) {
      setIsProcessing(false);
      setSaveError(err instanceof Error ? err.message : "Failed to save this photo");
    }
  }

  function handleClose() {
    const hasProgress = recorderState !== "idle" || recordedChunksRef.current.length > 0;
    if (hasProgress && !window.confirm("Discard this recording?")) return;
    router.push(`/dashboard/${projectId}`);
  }

  const isBusy = isProcessing;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex items-center justify-between p-3">
        <button type="button" onClick={handleClose} aria-label="Close" className="rounded-full bg-white/10 p-2 text-xl leading-none">
          ✕
        </button>
        {hasMultipleCameras && recorderState === "idle" && (
          <button type="button" onClick={handleFlipCamera} aria-label="Flip camera" className="rounded-full bg-white/10 p-2">
            <FlipCameraIcon className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        {cameraError ? (
          <div className="flex max-w-xs flex-col items-center gap-3 p-6 text-center text-sm text-white/80">
            <p>{cameraError}</p>
            <button
              type="button"
              onClick={() => setRetryToken((n) => n + 1)}
              className="rounded-md bg-white/10 px-3 py-1.5 text-white"
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            {/* Off-screen but still playing/decoding -- the canvas below is
                the only thing actually shown; see this file's own module
                comment for why every consumer (preview/record/snap) reads
                from that composited canvas instead of this raw feed. */}
            <video ref={videoRef} muted playsInline className="absolute h-px w-px opacity-0" />
            <canvas ref={canvasRef} className="max-h-full max-w-full" />

            {recorderState !== "idle" && (
              <div className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-sm">
                <span className={recorderState === "recording" ? "text-red-500" : "text-white/70"}>●</span>
                <span>{recorderState === "paused" ? "Paused" : "Recording"}</span>
                <span className="text-white/70">
                  {formatTimer(recordedMs)} / {formatTimer(MAX_RECORDING_SECONDS * 1000)}
                </span>
              </div>
            )}

            {capWarning && (
              <div className="absolute bottom-4 left-1/2 w-[90%] max-w-sm -translate-x-1/2 rounded-md bg-black/80 px-3 py-2 text-center text-xs text-white">
                Recording can&apos;t exceed 3 minutes — stopped automatically.
              </div>
            )}
          </>
        )}
      </div>

      {!cameraError && (
        <div className="flex flex-col gap-2 px-3 pb-1">
          {openPicker === "filter" && (
            <PillRow options={FILTER_PRESET_OPTIONS.filter((o) => o.id !== "none").map((o) => ({ id: o.id, label: o.name }))} selectedId={filterId} onSelect={setFilterId} />
          )}
          {openPicker === "ambience" && (
            <PillRow options={AMBIENT_EFFECT_OPTIONS.map((o) => ({ id: o.id, label: o.label }))} selectedId={ambientEffectId} onSelect={setAmbientEffectId} />
          )}
          {openPicker === "face" && (
            <PillRow options={FACE_EFFECT_OPTIONS.map((o) => ({ id: o.id, label: o.label }))} selectedId={faceEffectId} onSelect={setFaceEffectId} />
          )}
          <div className="flex justify-center gap-2">
            {(
              [
                ["filter", "Filter", filterId !== null && filterId !== "none"],
                ["ambience", "Ambience", ambientEffectId !== null],
                ["face", "Face effect", faceEffectId !== null],
              ] as const
            ).map(([key, label, active]) => (
              <button
                key={key}
                type="button"
                onClick={() => setOpenPicker((prev) => (prev === key ? null : key))}
                className={`rounded-full border px-3 py-1 text-xs ${
                  openPicker === key || active ? "border-accent text-accent" : "border-white/30 text-white/80"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {saveError && <p className="px-3 pb-1 text-center text-xs text-red-400">{saveError}</p>}

      {!cameraError && (
        <div className="flex items-center justify-center gap-8 p-4 pb-6">
          <button
            type="button"
            onClick={() => void handleSnapPhoto()}
            disabled={isBusy}
            aria-label="Take photo"
            title="Take a photo"
            className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-white disabled:opacity-40"
          >
            <span className="h-8 w-8 rounded-full bg-white" />
          </button>

          <button
            type="button"
            onClick={() => (recorderState === "recording" ? handlePause() : handleStartOrResume())}
            disabled={isBusy}
            aria-label={recorderState === "recording" ? "Pause recording" : recorderState === "paused" ? "Resume recording" : "Start recording"}
            title={recorderState === "recording" ? "Pause" : recorderState === "paused" ? "Resume" : "Start recording"}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 disabled:opacity-40"
          >
            {recorderState === "recording" ? (
              <PauseIcon className="h-7 w-7 text-white" />
            ) : recorderState === "paused" ? (
              <PlayIcon className="h-7 w-7 text-white" />
            ) : (
              <span className="h-6 w-6 rounded-full bg-white" />
            )}
          </button>

          {recorderState !== "idle" ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              disabled={isBusy}
              aria-label="Finish recording"
              title="Finish"
              className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-white text-xl disabled:opacity-40"
            >
              ✓
            </button>
          ) : (
            <span className="h-12 w-12" />
          )}
        </div>
      )}

      {isProcessing && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <ReelLoader stage={processingStage} />
        </div>
      )}
    </div>
  );
}
