"use client";

/**
 * Full-screen live camera capture -- opened from TopMenuBar's Record button
 * (right after the Cover thumbnail) and AssetGallery/MobileAssetStrip's own
 * "+ Record"/"Record" action, at dashboard/[projectId]/record, AND
 * project-agnostically from the Recordings library's own Record button, at
 * recordings/record (projectId null there -- see this file's own
 * `projectId` prop comment). Works the same way on desktop (webcam) and
 * mobile (front/back switch): one
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
 * Saves into the user's own personal Recordings library (POST
 * /api/recordings -- see /recordings, reachable from TopMenuBar's spool
 * icon) rather than straight into this project's own assets or the
 * separate finished-renders /library page -- a recording is raw footage to
 * edit with, kept across every project, not tied to the one it happened to
 * be recorded from. Pulling it into a specific reel's Assets panel is a
 * deliberate later step (the "+Asset" popup's Recordings tab).
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadRecordingWithProgress } from "@/lib/api";
import { ReelLoader } from "@/components/ReelLoader";
import { FILTER_PRESET_OPTIONS, getFilterPresetOption, type FilterPresetId } from "@/lib/video/filterPresets";
import { AMBIENT_EFFECT_OPTIONS, ambientEffectSeed, drawAmbientEffect, type AmbientEffectId } from "@/lib/video/ambientEffects";
import { FACE_EFFECT_OPTIONS, detectFaceGeometryForVideoFrame, type FaceEffectId, type FaceGeometry } from "@/lib/video/faceLandmarks";
import { segmentVideoFrameApproximate } from "@/lib/video/backgroundSegmentation";
import { Camera3DRenderer, NEUTRAL_POSE } from "@/lib/video/camera3D";
import { computeCoverFitSourceRect } from "@/lib/video/video_math";
import { pickMediaRecorderMimeType, toMp4Asset } from "@/lib/media/cameraRecording";
import { useIsMobile } from "@/lib/useIsMobile";
import { FlipCameraIcon, PlayIcon, PauseIcon, ResetIcon, TeleprompterIcon, EyeIcon, EyeOffIcon } from "./icons/PlayerIcons";

const MAX_RECORDING_SECONDS = 180;
// Smart-default teleprompter scroll pace -- no manual speed knob (see this
// app's driving vision on favoring sensible defaults over exposing every
// control): an average comfortable read-aloud pace, so a script scrolls
// past in roughly the time it actually takes to read it out loud. Very
// short scripts still get at least TELEPROMPTER_MIN_SCROLL_SECONDS so a
// one-line script doesn't whip past in under a second.
const TELEPROMPTER_WORDS_PER_SECOND = 150 / 60;
const TELEPROMPTER_MIN_SCROLL_SECONDS = 6;
// Pause at the top once a full pass finishes, before looping back to the
// start -- lets the same script be reused for several takes in a row
// without having to reopen the popup or manually rewind.
const TELEPROMPTER_LOOP_PAUSE_MS = 1500;
const MIN_CAMERA_ZOOM = 1;
const MAX_CAMERA_ZOOM = 3;
const FACE_DETECT_INTERVAL_MS = 150;
// Heavier than face-landmark detection (a full selfie-segmentation model
// pass, not just landmark math), and only ever needed for "halo" -- see
// segmentVideoFrameApproximate's own doc comment -- so throttled coarser.
const SUBJECT_CUTOUT_INTERVAL_MS = 200;
const TARGET_FPS = 24;
const TIMER_TICK_MS = 250;
// Whatever the camera actually negotiates (getUserMedia's own aspectRatio/
// width hints below are only `ideal`, not binding -- plenty of devices/
// browsers hand back a different ratio, e.g. a landscape-sensor default),
// the recorded buffer is always center-cropped to this app's canonical
// reel shape (see
// lib/projects.ts's resetProject / lib/timeline/resolve.ts's REEL_WIDTH/
// REEL_HEIGHT) so footage recorded here never needs an unpredictable
// re-crop later, and so the live preview -- once sized via CSS to match --
// shows exactly the framing that gets saved.
const CAPTURE_ASPECT_RATIO = 9 / 16;
// Gates the one-time "hold your phone farther away" framing tip (see the
// acquireCameraStream aspectRatio comment above for why this app's camera
// framing can run narrower than the phone's own native camera app) --
// shown once ever, same "reel-creator-" prefixed localStorage convention as
// this app's saved theme (see app/layout.tsx).
const FRAMING_TIP_DISMISSED_KEY = "reel-creator-camera-framing-tip-seen";
// A plain cover-fit (zoom=1, minZoom=1) is the ONLY safe setting here.
// computeCoverFitSourceRect's own doc comment is explicit that a `minZoom`
// below 1 (zooming out past cover) is only ever safe for a Picture-in-Picture
// box that has a backdrop behind it worth revealing once the requested
// window exceeds the source's real bounds and gets clipped back down. This
// canvas has no such backdrop -- it's the sole, full-bleed content, redrawn
// every rAF tick without ever being cleared -- so an earlier attempt at a
// zoom-out-past-cover value here (0.82, to reveal a bit more room around the
// body) didn't "harmlessly" no-op on a 9:16-exact source as its own comment
// assumed: a "cover" crop already has ZERO slack in at least one axis by
// construction (that's what makes it a cover crop), so ANY value below 1
// always pushed that axis's sWidth/sHeight past the source's actual
// dimensions, got clipped by drawImage per spec, and left a shrinking
// stale-pixel border/gap around the live feed instead of filling the full
// reel frame -- on every device, not just an edge case (reported as the
// recording not fitting the mobile reel clip size, on both laptop and
// mobile). The "reveal a bit more" intent is instead already satisfied by
// requesting a camera stream wider than 9:16 in the first place (see the
// aspectRatio/width `ideal` hints below) and cover-cropping THAT down to
// 9:16.

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

/** Popup for typing/editing the teleprompter script -- opened from the
 * Teleprompter icon in CameraCapturePage's header. Same hand-built
 * backdrop-plus-card dialog pattern as this app's other popups (e.g.
 * UpgradeRequiredDialog), since this codebase has no dialog component
 * library. */
function TeleprompterDialog({
  initialText,
  onCancel,
  onClear,
  onSave,
}: {
  initialText: string;
  onCancel: () => void;
  onClear: () => void;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initialText);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Teleprompter script"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
    >
      <div
        className="flex w-full max-w-md flex-col gap-3 rounded-lg bg-neutral-900 p-4 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-medium">What do you want to read out?</p>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type or paste your script here…"
          rows={8}
          className="w-full resize-none rounded-md border border-white/20 bg-black/40 p-2 text-sm text-white placeholder:text-white/40 focus:border-accent focus:outline-none"
        />
        <div className="flex justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              onClear();
              onCancel();
            }}
            className="rounded-md px-3 py-1.5 text-sm text-white/60"
          >
            Clear
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="rounded-md bg-white/10 px-3 py-1.5 text-sm">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave(draft)}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-accent-foreground"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CameraCapturePage({ projectId }: { projectId: string | null }) {
  const router = useRouter();
  // Recordings are user-scoped, not project-scoped (see this file's own
  // module comment) -- projectId is only used below for the ambient-effect
  // seed and where to navigate back to on close/finish, both of which have
  // a sensible fallback when this page was opened from the Recordings
  // library itself rather than from a specific project's editor.
  const returnPath = projectId ? `/dashboard/${projectId}` : "/recordings";
  // Same responsive check the editor uses to pick MobileEditor vs
  // ThreePaneEditor -- this page has no separate mobile build, one
  // component serves both (see this file's own module comment), but a
  // touch phone's front/back cameras and cramped screen still warrant a
  // different default facing mode and a zoom control desktop webcams have
  // no equivalent need for.
  const { isMobile, isReady: isMobileCheckReady } = useIsMobile();

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
  // Holds the screen awake for the duration of a take -- mobile screens
  // dimming/locking mid-recording is a real failure mode for a browser-
  // based recorder that a native camera app never has to worry about
  // (the OS itself already knows a camera app is active). Feature-detected
  // and best-effort (see acquireWakeLock below), same pattern as the
  // camera `zoom` capability reset above.
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // Ticks 3-2-1 before a FRESH take's recording actually starts (see
  // beginCountdownThenRecord) -- null whenever no countdown is in flight.
  // recorderState deliberately stays "idle" for the whole countdown (the
  // recorder itself hasn't started yet), so every `recorderState !==
  // "idle"` check that hides Reset/Finish already keeps them hidden with
  // no extra logic needed.
  const [countdownValue, setCountdownValue] = useState<number | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Makes sure the mobile selfie-mode default (below) is only ever applied
  // once, right when isMobileCheckReady first turns true -- otherwise it'd
  // re-fire and stomp on a manual flip-camera tap every time isMobile is
  // merely re-evaluated (e.g. a window resize crossing the breakpoint).
  const didApplyMobileDefaultFacingModeRef = useRef(false);

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

  // Digital zoom -- mobile-only UI (see the zoom slider below), but wired
  // generically so it's a no-op (always 1) on desktop. Applied as the
  // `zoom` factor of the SAME cover-fit crop the draw loop already takes
  // (see CAPTURE_ASPECT_RATIO's own comment) -- cropping IN past cover is
  // always safe there; only cropping OUT past it isn't, which is why this
  // never goes below MIN_CAMERA_ZOOM (1).
  const [zoom, setZoom] = useState(MIN_CAMERA_ZOOM);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // One-time "hold farther away" framing tip -- see
  // FRAMING_TIP_DISMISSED_KEY's own comment.
  const [showFramingTip, setShowFramingTip] = useState(false);

  // The script the user wants to read out loud, shown scrolling over the
  // live preview so their eyes stay near the camera lens instead of down at
  // a phone/paper -- see this file's own module comment for the recording
  // pipeline this overlay sits on top of (it's a DOM overlay, not baked
  // into the recorded canvas -- the recording is just the person looking at
  // camera, not the prompter text itself).
  const [teleprompterText, setTeleprompterText] = useState("");
  const [showTeleprompterDialog, setShowTeleprompterDialog] = useState(false);
  // Lets the text stay entered (no need to retype between takes) while
  // temporarily getting it off the screen -- independent of whether any
  // text has been typed at all.
  const [teleprompterVisible, setTeleprompterVisible] = useState(true);
  // Whether the script is actually auto-scrolling right now -- independent
  // of recorderState (see the scroll-active effect below). Defaults false
  // (a freshly saved script sits paused at the top) rather than scrolling
  // the instant it's saved, so it never moves before the user is actually
  // ready -- reported as "it starts as soon as the recording starts,"
  // provide ways to pause and reset it. handleStartOrResume's fresh-take
  // branch flips this true once the countdown below actually finishes, so
  // the common "type script, hit record" flow still needs no extra tap.
  const [teleprompterPlaying, setTeleprompterPlaying] = useState(false);
  const teleprompterInnerRef = useRef<HTMLDivElement | null>(null);
  const teleprompterScrollPxRef = useRef(0);
  const teleprompterPauseUntilMsRef = useRef(0);
  const teleprompterLastTsRef = useRef<number | null>(null);
  const teleprompterDurationSecondsRef = useRef(TELEPROMPTER_MIN_SCROLL_SECONDS);

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

  // Best-effort -- unsupported browsers (feature-detected) or a refusal
  // (e.g. low battery mode) just leave the OS's own screen-timeout in
  // place, same as this file's other best-effort hardware calls.
  async function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch {
      // Ignored -- see this function's own doc comment.
    }
  }

  // Defaults a touch/phone-sized session to the front (selfie) camera --
  // the influencer/creator this app targets is filming themselves, and
  // starting on the back camera (this page's original, desktop-webcam-era
  // default) means an extra flip tap on every single mobile recording.
  // Deferred until isMobileCheckReady (rather than read synchronously into
  // facingMode's own useState initializer) so the very first
  // getUserMedia request below already asks for the right camera instead of
  // opening the back one first and immediately re-requesting the front --
  // see the acquisition effect's own `if (!isMobileCheckReady) return`
  // guard, which holds off that request until this has had a chance to run.
  useEffect(() => {
    if (!isMobileCheckReady || didApplyMobileDefaultFacingModeRef.current) return;
    didApplyMobileDefaultFacingModeRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time default applied the instant isMobileCheckReady turns true (guarded by the ref above), same "can't know earlier" reasoning as useIsMobile's own first matchMedia read
    if (isMobile) setFacingMode("user");
  }, [isMobileCheckReady, isMobile]);

  // Shows the framing tip once ever, only on the mobile handheld case the
  // complaint was actually about (a desktop webcam isn't held at arm's
  // length) -- auto-dismisses itself after a few seconds either way.
  useEffect(() => {
    if (!isMobileCheckReady || !isMobile) return;
    let alreadySeen = false;
    try {
      alreadySeen = localStorage.getItem(FRAMING_TIP_DISMISSED_KEY) === "1";
    } catch {
      // Ignored -- private browsing / storage access can throw; falls
      // through to showing the tip this once rather than erroring out.
    }
    if (alreadySeen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time reveal gated by a client-only localStorage read, same reasoning as the mobile-default-facing-mode effect above
    setShowFramingTip(true);
    const timeout = setTimeout(dismissFramingTip, 6000);
    return () => clearTimeout(timeout);
  }, [isMobileCheckReady, isMobile]);

  function dismissFramingTip() {
    setShowFramingTip(false);
    try {
      localStorage.setItem(FRAMING_TIP_DISMISSED_KEY, "1");
    } catch {
      // Ignored -- best-effort persistence only, same as the read above.
    }
  }

  // Acquires (and re-acquires on camera flip) the camera+mic stream. Holds
  // off until isMobileCheckReady so it never has to acquire twice just to
  // pick up the mobile selfie-mode default above.
  useEffect(() => {
    if (!isMobileCheckReady) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change (facingMode/retryToken), same pattern as CutawayDialog's own re-sync effects
    setCameraError(null);

    async function acquireCameraStream(): Promise<MediaStream> {
      const baseVideoConstraints: MediaTrackConstraints = {
        facingMode,
        frameRate: { ideal: TARGET_FPS, max: TARGET_FPS },
      };
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {
            ...baseVideoConstraints,
            // Deliberately an ASPECT RATIO, not a fixed width+height --
            // pinning BOTH dimensions as "ideal" (this page's original
            // 960x1280 request) is exactly the kind of ask that steers a
            // phone's camera HAL toward a specific, often reduced/
            // pre-cropped capture mode instead of its native full-sensor
            // one, which is the actual reason a handheld selfie here
            // frames much tighter than the same phone's own native camera
            // app at the same arm's-length distance (reported as "only
            // get my head, the regular camera gets almost half my body").
            // The cover-fit crop below already preserves full height (zero
            // slack there once cropped to this app's 9:16 canvas -- see
            // CAPTURE_ASPECT_RATIO's own comment), so the narrow framing
            // traces back to the raw stream negotiated HERE, not anything
            // cropped away afterward. Asking for the RATIO (with only a
            // loose width, no height) instead lets the browser pick its
            // own best/native resolution satisfying it -- the standard
            // technique for recovering full sensor field-of-view. Not a
            // guaranteed fix: which capture mode a given phone/browser
            // actually picks is an OS/HAL behavior outside this app's
            // control.
            aspectRatio: { ideal: 3 / 4 },
            width: { ideal: 1280 },
          },
        });
      } catch (err) {
        if (!(err instanceof DOMException) || err.name !== "OverconstrainedError") throw err;
        // Some devices reject the aspectRatio/width hint outright -- retry
        // with the bare minimum rather than hard-failing camera access.
        return navigator.mediaDevices.getUserMedia({ audio: true, video: baseVideoConstraints });
      }
    }

    acquireCameraStream()
      .then(async (mediaStream) => {
        if (cancelled) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = mediaStream;
        // Some multi-lens phones (mainly Android/Chrome) hand back a stream
        // whose HARDWARE zoom the OS already nudged above 1x -- nothing to
        // do with this page's own digital `zoom` state (still MIN_CAMERA_ZOOM
        // here) or the cover-fit crop above, which only ever sees whatever
        // frame the track already produced. Where the track exposes a `zoom`
        // capability (Chrome's own MediaTrackConstraints extension, not
        // standard -- Safari/Firefox simply won't have it), reset it to that
        // capability's own minimum so this page always starts from the
        // widest optical framing the lens can actually deliver.
        const [videoTrack] = mediaStream.getVideoTracks();
        // `zoom` is a real, shipped Chrome MediaTrackCapabilities/Constraints
        // extension (https://w3c.github.io/mediacapture-image/#zoom) that
        // TypeScript's DOM lib doesn't model -- cast through `unknown` rather
        // than widening the whole capabilities/constraints object.
        const zoomCapability = (videoTrack?.getCapabilities?.() as unknown as { zoom?: { min: number } } | undefined)?.zoom;
        if (zoomCapability && zoomCapability.min !== undefined) {
          try {
            await videoTrack.applyConstraints({ advanced: [{ zoom: zoomCapability.min } as unknown as MediaTrackConstraintSet] });
          } catch {
            // Best-effort -- an unsupported/rejected constraint just leaves
            // the OS's own default zoom in place.
          }
        }
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
  }, [facingMode, retryToken, isMobileCheckReady]);

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

      // Center-crop whatever the camera actually delivers down to this app's
      // 9:16 reel shape -- see CAPTURE_ASPECT_RATIO's own comment -- rather
      // than letting the buffer just track the negotiated stream's own
      // (unpredictable) ratio. A plain cover fit (zoom=1, minZoom=1, the
      // defaults) -- see CAPTURE_ASPECT_RATIO's own comment for why this is
      // the only setting that always fully fills the buffer. The BUFFER's
      // own size is always taken from this unzoomed cover fit -- kept
      // separate from the (possibly zoomed-in) crop actually drawn below --
      // so the mobile zoom slider changes how much of the source is sampled
      // without ever shrinking the recorded/canvas resolution itself.
      const bufferCrop = computeCoverFitSourceRect(video.videoWidth, video.videoHeight, CAPTURE_ASPECT_RATIO, 1);
      const bufferWidth = Math.round(bufferCrop.sWidth);
      const bufferHeight = Math.round(bufferCrop.sHeight);
      if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
        canvas.width = bufferWidth;
        canvas.height = bufferHeight;
      }
      const zoomLevel = zoomRef.current;
      const crop =
        zoomLevel === MIN_CAMERA_ZOOM
          ? bufferCrop
          : computeCoverFitSourceRect(video.videoWidth, video.videoHeight, CAPTURE_ASPECT_RATIO, 1, 0.5, 0.5, zoomLevel);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const elapsedSeconds = (performance.now() - sessionStartMsRef.current) / 1000;
      const currentFaceEffect = faceEffectIdRef.current;
      const currentAmbientEffect = ambientEffectIdRef.current;

      ctx.filter = getFilterPresetOption(filterIdRef.current).cssFilter;
      if (currentFaceEffect) {
        getCamera3DRenderer().drawImage3D(
          ctx, video, NEUTRAL_POSE, crop.sx, crop.sy, crop.sWidth, crop.sHeight, 0, 0, canvas.width, canvas.height, false, false,
          currentAmbientEffect ? { effectId: currentAmbientEffect, elapsedSeconds, seed: ambientEffectSeed(projectId ?? "recordings") } : null,
          currentFaceEffect === "halo" ? liveSubjectCutoutRef.current : null,
          liveFaceGeometryRef.current ? { effectId: currentFaceEffect, geometry: liveFaceGeometryRef.current, elapsedSeconds } : null
        );
      } else {
        ctx.drawImage(video, crop.sx, crop.sy, crop.sWidth, crop.sHeight, 0, 0, canvas.width, canvas.height);
        ctx.filter = "none";
        if (currentAmbientEffect) {
          drawAmbientEffect(ctx, currentAmbientEffect, 0, 0, canvas.width, canvas.height, elapsedSeconds, ambientEffectSeed(projectId ?? "recordings"));
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
            // A null result is a transient failure for THIS pass only (see
            // segmentVideoFrameApproximate's own doc comment) -- keep the
            // last good cutout rather than dropping it, otherwise the halo
            // has nothing to occlude it and visibly pops in front of the
            // face for this throttle window (reported as "halo comes in
            // front, sometimes").
            if (!bitmap) return;
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
      if (countdownIntervalRef.current !== null) clearInterval(countdownIntervalRef.current);
      void wakeLockRef.current?.release();
    };
  }, []);

  // The Wake Lock API auto-releases whenever the tab loses visibility (a
  // documented quirk, not something this app's own code triggers) -- so a
  // take left running while the phone's screen was off/backgrounded (a
  // notification pulled the browser away, say) needs it re-requested once
  // the page is actually visible again, or the screen could still dim mid
  // takes for the rest of that recording.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && recorderState === "recording" && !wakeLockRef.current) {
        void acquireWakeLock();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [recorderState]);

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

  // Recomputes the smart-default scroll pace whenever the script itself
  // changes -- see TELEPROMPTER_WORDS_PER_SECOND's own comment. Read from a
  // ref (not plain state) by the scroll rAF loop below so editing the
  // script doesn't need to restart that loop.
  useEffect(() => {
    const wordCount = teleprompterText.trim().length === 0 ? 0 : teleprompterText.trim().split(/\s+/).length;
    teleprompterDurationSecondsRef.current = Math.max(wordCount / TELEPROMPTER_WORDS_PER_SECOND, TELEPROMPTER_MIN_SCROLL_SECONDS);
  }, [teleprompterText]);

  function resetTeleprompterScroll() {
    teleprompterScrollPxRef.current = 0;
    teleprompterPauseUntilMsRef.current = 0;
    teleprompterLastTsRef.current = null;
    if (teleprompterInnerRef.current) teleprompterInnerRef.current.style.transform = "translateY(0px)";
  }

  // Auto-scrolls the teleprompter text upward, karaoke-style, at the smart
  // default pace computed above -- active whenever there's a script to
  // show, it isn't hidden, AND the user has actually pressed its own
  // Play (teleprompterPlaying -- see that state's own doc comment: a
  // fresh take flips this true once recording actually starts, but it's
  // independent of recorderState the rest of the time, so it can be
  // paused/resumed/reset without touching the recording itself). Pausing
  // the RECORDING still force-holds it too (recorderState !== "paused"),
  // since stepping away from a take should stop the script along with it.
  // Applies the scroll offset straight to the DOM node via a ref rather
  // than React state, same reasoning as the compositing loop above reading
  // its own effect toggles from refs -- a per-frame re-render for a value
  // nothing else derives from would be pure waste.
  useEffect(() => {
    const active = teleprompterText.trim().length > 0 && teleprompterVisible && teleprompterPlaying && recorderState !== "paused";
    if (!active) return;

    let rafId: number;
    function tick(ts: number) {
      rafId = requestAnimationFrame(tick);
      const inner = teleprompterInnerRef.current;
      if (!inner) return;

      if (teleprompterLastTsRef.current === null) teleprompterLastTsRef.current = ts;
      const deltaMs = ts - teleprompterLastTsRef.current;
      teleprompterLastTsRef.current = ts;

      if (performance.now() < teleprompterPauseUntilMsRef.current) return;

      const textHeight = inner.scrollHeight;
      const pxPerMs = textHeight / (teleprompterDurationSecondsRef.current * 1000);
      teleprompterScrollPxRef.current += deltaMs * pxPerMs;
      // Loops back to the top (after a short pause, so it's readable as
      // "starting over" rather than a jarring snap) once the full script
      // has scrolled past -- lets the same script serve several takes in a
      // row without reopening the popup.
      if (teleprompterScrollPxRef.current >= textHeight) {
        teleprompterScrollPxRef.current = 0;
        teleprompterPauseUntilMsRef.current = performance.now() + TELEPROMPTER_LOOP_PAUSE_MS;
      }
      inner.style.transform = `translateY(-${teleprompterScrollPxRef.current}px)`;
    }
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      teleprompterLastTsRef.current = null;
    };
  }, [teleprompterText, teleprompterVisible, teleprompterPlaying, recorderState]);

  function handleSaveTeleprompterText(text: string) {
    setTeleprompterText(text);
    setTeleprompterVisible(true);
    setTeleprompterPlaying(false);
    resetTeleprompterScroll();
    setShowTeleprompterDialog(false);
  }

  function handleFlipCamera() {
    setFacingMode((prev) => (prev === "user" ? "environment" : "user"));
  }

  // The actual MediaRecorder setup -- pulled out of handleStartOrResume so
  // a fresh take's countdown (beginCountdownThenRecord below) can delay
  // calling this until the user has actually had time to get in frame,
  // without duplicating any of the setup itself.
  function startRecordingNow() {
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
    // A fresh take always reads from the top of the script, regardless of
    // how far a rehearsal scroll had already gotten, and starts it running
    // automatically -- see teleprompterPlaying's own doc comment.
    resetTeleprompterScroll();
    setTeleprompterPlaying(true);
    void acquireWakeLock();
    setRecorderState("recording");
  }

  // Ticks 3-2-1 before a FRESH take's recording actually starts -- gives
  // time to get positioned/settled in frame right after tapping the
  // shutter, the way a phone camera's own self-timer does. Deliberately
  // NOT used for resuming from a pause (see handleStartOrResume below) --
  // only a take's very first start warrants the "get ready" window.
  function beginCountdownThenRecord() {
    setCountdownValue(3);
    // Tracked in a plain local (not read back from state) so the actual
    // "start recording" side effect below runs from a normal interval tick
    // rather than from inside a setState updater callback, which React can
    // invoke more than once (e.g. under StrictMode) since updaters are
    // expected to be pure.
    let remainingSeconds = 3;
    countdownIntervalRef.current = setInterval(() => {
      remainingSeconds -= 1;
      if (remainingSeconds <= 0) {
        if (countdownIntervalRef.current !== null) clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
        setCountdownValue(null);
        startRecordingNow();
      } else {
        setCountdownValue(remainingSeconds);
      }
    }, 1000);
  }

  function cancelCountdown() {
    if (countdownIntervalRef.current !== null) clearInterval(countdownIntervalRef.current);
    countdownIntervalRef.current = null;
    setCountdownValue(null);
  }

  function handleStartOrResume() {
    // Mid-countdown, the shutter button (see the render below) doubles as
    // a Cancel -- tapping it again shouldn't stack a second countdown.
    if (countdownValue !== null) {
      cancelCountdown();
      return;
    }
    if (recorderState === "idle") {
      beginCountdownThenRecord();
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
    setTeleprompterPlaying(false);
    await stopMediaRecorder(recorder);
    void wakeLockRef.current?.release();
    wakeLockRef.current = null;

    setIsProcessing(true);
    setSaveError(null);
    try {
      setProcessingStage("Preparing your recording…");
      const rawBlob = new Blob(recordedChunksRef.current, { type: recorder.mimeType });
      const file = await toMp4Asset(rawBlob, `recording-${Date.now()}.mp4`);
      setProcessingStage("Saving to your recordings…");
      const durationSeconds = accumulatedRecordedMsRef.current / 1000;
      await uploadRecordingWithProgress(
        file,
        `Recording — ${new Date().toLocaleString()}`,
        null,
        durationSeconds,
        (fraction) => setProcessingStage(`Saving to your recordings… ${Math.round(fraction * 100)}%`)
      );
      router.push(returnPath);
    } catch (err) {
      setIsProcessing(false);
      setSaveError(err instanceof Error ? err.message : "Failed to save this recording");
    }
  }

  // Discards everything recorded in this session so far (no upload) and
  // drops back to "idle" so the user can record again without leaving the
  // page -- distinct from handleStop, which finalizes+uploads and navigates
  // away. Shares handleStop's isStoppingRef guard so the two can't race
  // (e.g. the 3-minute auto-cap firing handleStop in the same tick as a
  // Reset tap).
  async function handleReset() {
    if (isStoppingRef.current) return;
    if (recorderState === "idle" && recordedChunksRef.current.length === 0) return;
    if (!window.confirm("Discard this recording and start over?")) return;
    isStoppingRef.current = true;
    try {
      cancelCountdown();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") await stopMediaRecorder(recorder);
      mediaRecorderRef.current = null;
      recordedChunksRef.current = [];
      accumulatedRecordedMsRef.current = 0;
      segmentStartMsRef.current = 0;
      setRecordedMs(0);
      setCapWarning(false);
      setRecorderState("idle");
      // A discarded take goes back to a clean, paused-at-top prompter --
      // same reasoning as teleprompterPlaying's own doc comment.
      setTeleprompterPlaying(false);
      resetTeleprompterScroll();
      void wakeLockRef.current?.release();
      wakeLockRef.current = null;
    } finally {
      isStoppingRef.current = false;
    }
  }

  async function handleSnapPhoto() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setIsProcessing(true);
    setSaveError(null);
    setProcessingStage("Saving to your recordings…");
    try {
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("Couldn't capture a photo");
      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
      await uploadRecordingWithProgress(
        file,
        `Photo — ${new Date().toLocaleString()}`,
        null,
        null,
        (fraction) => setProcessingStage(`Saving to your recordings… ${Math.round(fraction * 100)}%`)
      );
      router.push(returnPath);
    } catch (err) {
      setIsProcessing(false);
      setSaveError(err instanceof Error ? err.message : "Failed to save this photo");
    }
  }

  function handleClose() {
    const hasProgress = recorderState !== "idle" || recordedChunksRef.current.length > 0;
    if (hasProgress && !window.confirm("Discard this recording?")) return;
    router.push(returnPath);
  }

  const isBusy = isProcessing;
  // Everything below the header shares this same "just under the header,
  // safe-area aware" top offset -- the recording timer badge, the
  // teleprompter box, its hidden-state pill, and the framing tip all used
  // to sit relative to a video box that already started below a separate
  // header row; now that the canvas is a true full-bleed layer (see this
  // section's own comment below), each of them needs to account for the
  // floating header's own height instead.
  const BELOW_HEADER_TOP = "top-[calc(env(safe-area-inset-top)+56px)]";

  return (
    <div className="fixed inset-0 z-50 overflow-hidden overscroll-none bg-black text-white">
      {cameraError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-white/80">
          <p className="max-w-xs">{cameraError}</p>
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
          {/* Full-bleed base layer -- fills the entire page so every control
              below floats OVER the live feed as a semi-transparent overlay,
              the same visual language a native camera app uses, instead of
              the feed being squeezed by chrome rows that eat into its own
              height. object-contain scales the canvas's actual pixel buffer
              (its width/height attributes, kept at a 9:16 ratio by the draw
              loop above) up to fill this box, letterboxing only if the
              viewport itself isn't 9:16. */}
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-contain" />

          {showFramingTip && (
            <div
              className={`absolute inset-x-6 z-10 rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-white/90 ${BELOW_HEADER_TOP}`}
            >
              Tip: hold your phone a bit farther away for a wider shot, closer
              to what your regular camera app shows.
              <button type="button" onClick={dismissFramingTip} className="ml-2 underline">
                Got it
              </button>
            </div>
          )}

          {teleprompterText.trim().length > 0 &&
            (teleprompterVisible ? (
              // Positioned toward the top -- a phone's front camera (and a
              // laptop's webcam) sits above the screen, so keeping the
              // text close to it is what actually keeps the recorded eyes
              // reading as "looking at camera" rather than looking down.
              // The mask-image fades both this box's own backdrop and the
              // text near its top/bottom edges -- the "karaoke" scrolling
              // look, and a visual cue that more text is coming.
              <div
                onClick={resetTeleprompterScroll}
                role="button"
                aria-label="Restart teleprompter from the top"
                title="Tap to restart from the top"
                className={`absolute inset-x-3 z-10 h-[32%] cursor-pointer overflow-hidden rounded-lg bg-black/45 ${BELOW_HEADER_TOP}`}
                style={{
                  WebkitMaskImage: "linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)",
                  maskImage: "linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)",
                }}
              >
                <div
                  ref={teleprompterInnerRef}
                  className="px-8 py-3 text-center text-lg font-medium leading-snug whitespace-pre-wrap text-white"
                >
                  {teleprompterText}
                </div>
                {/* Independent of the recording's own Pause -- see
                    teleprompterPlaying's own doc comment -- so the script
                    can be paused/resumed/restarted without touching the
                    take itself. */}
                <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTeleprompterPlaying((prev) => !prev);
                    }}
                    aria-label={teleprompterPlaying ? "Pause teleprompter" : "Play teleprompter"}
                    title={teleprompterPlaying ? "Pause script" : "Play script"}
                    className="rounded-full bg-black/60 p-1.5"
                  >
                    {teleprompterPlaying ? <PauseIcon className="h-4 w-4 text-white" /> : <PlayIcon className="h-4 w-4 text-white" />}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      resetTeleprompterScroll();
                    }}
                    aria-label="Restart teleprompter from the top"
                    title="Restart from top"
                    className="rounded-full bg-black/60 p-1.5"
                  >
                    <ResetIcon className="h-4 w-4 text-white" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTeleprompterVisible(false);
                    }}
                    aria-label="Hide teleprompter"
                    title="Hide"
                    className="rounded-full bg-black/60 p-1.5"
                  >
                    <EyeIcon className="h-4 w-4 text-white" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setTeleprompterVisible(true)}
                aria-label="Show teleprompter"
                title="Show script"
                className={`absolute right-3 z-10 flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white ${BELOW_HEADER_TOP}`}
              >
                <EyeOffIcon className="h-4 w-4" />
                Script hidden
              </button>
            ))}

          {recorderState !== "idle" && countdownValue === null && (
            <div className={`absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-sm ${BELOW_HEADER_TOP}`}>
              <span className={recorderState === "recording" ? "text-red-500" : "text-white/70"}>●</span>
              <span>{recorderState === "paused" ? "Paused" : "Recording"}</span>
              <span className="text-white/70">
                {formatTimer(recordedMs)} / {formatTimer(MAX_RECORDING_SECONDS * 1000)}
              </span>
            </div>
          )}

          {/* 3-2-1 countdown before a fresh take's recording actually
              starts -- see beginCountdownThenRecord's own doc comment.
              Tapping the shutter button again (still visible underneath,
              unchanged) cancels it back to idle. */}
          {countdownValue !== null && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30">
              <span className="text-8xl font-bold text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.7)]">{countdownValue}</span>
            </div>
          )}

          {capWarning && (
            <div className="absolute bottom-56 left-1/2 z-10 w-[90%] max-w-sm -translate-x-1/2 rounded-md bg-black/80 px-3 py-2 text-center text-xs text-white">
              Recording can&apos;t exceed 3 minutes — stopped automatically.
            </div>
          )}

          {/* Digital zoom (see the draw loop's own comment on how this
              stays resolution-safe) -- mobile only, a desktop webcam has
              no equivalent "step back/get closer" gesture a slider here
              would help with. Sits just above the floating bottom controls
              below. */}
          {isMobile && (
            <div className="absolute inset-x-10 bottom-40 z-10 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5">
              <input
                type="range"
                min={MIN_CAMERA_ZOOM}
                max={MAX_CAMERA_ZOOM}
                step={0.1}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="h-1.5 w-full cursor-ew-resize accent-accent"
                aria-label="Camera zoom"
              />
              <span className="w-9 shrink-0 text-right text-xs text-white/80">{zoom.toFixed(1)}x</span>
            </div>
          )}
        </>
      )}

      {/* Floating header -- always rendered (even on a camera error) so
          Close stays reachable. A gradient scrim (not a solid bar) keeps
          the icons legible over arbitrary video/background content while
          still reading as "floating over the feed" rather than a fixed
          opaque toolbar. */}
      <div
        className="absolute inset-x-0 top-0 z-20 flex items-start justify-between bg-gradient-to-b from-black/60 to-transparent p-3 pb-8 pt-[calc(env(safe-area-inset-top)+0.75rem)]"
      >
        <button type="button" onClick={handleClose} aria-label="Close" className="rounded-full bg-black/40 p-2 text-xl leading-none backdrop-blur-sm">
          ✕
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowTeleprompterDialog(true)}
            aria-label="Teleprompter script"
            title="Teleprompter"
            className={`rounded-full p-2 backdrop-blur-sm ${teleprompterText.trim().length > 0 ? "bg-accent text-accent-foreground" : "bg-black/40"}`}
          >
            <TeleprompterIcon className="h-5 w-5" />
          </button>
          {hasMultipleCameras && recorderState === "idle" && countdownValue === null && (
            <button type="button" onClick={handleFlipCamera} aria-label="Flip camera" className="rounded-full bg-black/40 p-2 backdrop-blur-sm">
              <FlipCameraIcon className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      {/* Floating bottom controls -- effects pill row + the main action
          row, both overlaid on the feed on a gradient scrim instead of
          sitting in their own opaque band below it (see this file's own
          module comment on why the canvas is now full-bleed). */}
      {!cameraError && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 pt-10 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
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

          {saveError && <p className="text-center text-xs text-red-400">{saveError}</p>}

          <div className="flex items-center justify-center gap-8 py-2">
            {recorderState !== "idle" ? (
              <button
                type="button"
                onClick={() => void handleReset()}
                disabled={isBusy}
                aria-label="Reset recording"
                title="Discard and start over"
                className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-white disabled:opacity-40"
              >
                <ResetIcon className="h-6 w-6 text-white" />
              </button>
            ) : (
              <span className="h-12 w-12" />
            )}

            <button
              type="button"
              onClick={() => void handleSnapPhoto()}
              disabled={isBusy || countdownValue !== null}
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
              aria-label={
                countdownValue !== null
                  ? "Cancel countdown"
                  : recorderState === "recording"
                    ? "Pause recording"
                    : recorderState === "paused"
                      ? "Resume recording"
                      : "Start recording"
              }
              title={countdownValue !== null ? "Cancel" : recorderState === "recording" ? "Pause" : recorderState === "paused" ? "Resume" : "Start recording"}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 disabled:opacity-40"
            >
              {countdownValue !== null ? (
                <span className="h-6 w-6 rounded-md bg-white" />
              ) : recorderState === "recording" ? (
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
        </div>
      )}

      {isProcessing && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80">
          <ReelLoader stage={processingStage} />
        </div>
      )}

      {showTeleprompterDialog && (
        <TeleprompterDialog
          initialText={teleprompterText}
          onCancel={() => setShowTeleprompterDialog(false)}
          onClear={() => setTeleprompterText("")}
          onSave={handleSaveTeleprompterText}
        />
      )}
    </div>
  );
}
