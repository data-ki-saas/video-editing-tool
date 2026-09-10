"use client";

/**
 * "Cutaway" tab's dialog -- appends a clip to the BASE sequence, either a
 * plain video (as-is, no animation options -- same operation "Append" used
 * to be, before it was folded into this one action) or one of this
 * project's photos turned into its own full-screen clip, animated via one
 * or more combined Ken Burns templates (lib/video/imageTemplates.ts). A
 * Video/Image segmented switch at the top picks which; Video collapses down
 * to just an asset grid + one click (nothing to animate/crop/duration-tune),
 * Image keeps the original three STACKED horizontal panels (not the
 * left/right split TranscriptCaptionDialog/TextOverlayDialog use): pick the
 * photo, pick the motion(s), position the clip rectangle + tune the
 * preview/duration, Add.
 *
 * Reopened in EDIT mode (via the `editing` prop) by clicking an existing
 * IMAGE segment on the Cutaways rail (CutawayTrack.tsx) -- a video segment
 * has nothing authored to edit in place, so it never reopens this dialog.
 * Edit mode forces Image kind and hides the kind switch entirely (same
 * three panels, pre-populated from that cutaway's current
 * photo/template(s)/duration/cropRect, with "Add cutaway" relabeled "Save
 * changes"). The caller (ThreePaneEditor) decides whether `onAddImage`
 * should append a new clip or edit the existing one in place; this dialog
 * itself doesn't know the difference beyond the copy change.
 *
 * The animated preview here is intentionally a standalone canvas, not
 * CanvasPlayer: there's no real sequence position for a NEW clip yet (it
 * doesn't exist until "Add cutaway" is pressed), so it just loops the
 * chosen template(s)' ZoomEffect over the chosen image directly, using the
 * exact same buildKenBurnsEffect + computeEffectiveCropRect the real clip
 * will use once added/saved (transformations.ts's
 * applyAddImageSequenceClip / applyEditImageSequenceClip) -- what's
 * previewed here can't drift from what actually gets committed.
 *
 * Positioning: the animation's `base` rect used to come straight from the
 * project's overall video-frame clip rectangle, applied as if it were
 * fractions of the PHOTO -- a real bug, since a photo's own dimensions are
 * unrelated to the video frame's. Now the user sees the reel's clip-
 * rectangle SHAPE (locked to `clipRectAspectRatio`) drawn directly on the
 * actual photo and drags/resizes it into place (via CropRectOverlay, the
 * same move+aspect-locked-resize interaction the main clip-rectangle editor
 * on FrameStrip already uses) -- that positioned rect, in fractions of the
 * photo itself, is what's actually persisted and animated from.
 *
 * Below the panels, three stacked rows (not one crowded wrapping line):
 * Background removal (RemovalModePicker -- "Keep"/a solid-color backdrop
 * keyed out live via lib/video/chromaKey.ts, including an eyedropper that
 * samples a pixel straight off the photo above/AI removal), then Look &
 * motion (Filter, "Make it 3D", Ambience, Face effect, Pulse with music --
 * every purely-cosmetic effect, all previewed live on Panel 3's own
 * animated canvas the instant they're picked), then Cancel/Add. Filter used
 * to be reachable only AFTERWARD via the Cutaways rail's right-click
 * "Filter…" (still there, unchanged, for a clip already placed) -- it's
 * folded in here too so it's visible and previewed at add-time like
 * everything else, not a second disconnected step. "Remove Cutaway" isn't
 * one of these rows -- that's the rail's own right-click action
 * (CutawayTrack.tsx), no need for a second copy of it in here.
 */
import { useEffect, useRef, useState } from "react";
import type { Asset } from "@/lib/api";
import { computeContainRect, computeEffectiveCropRect, computeMaxCoverageCropFraction, FULL_FRAME_CROP_RECT, type CropRect } from "@/lib/video/video_math";
import { loadCrossOriginImage } from "@/lib/crossOriginImage";
import { useCrossOriginImageSrcMap } from "@/lib/useCrossOriginImageSrc";
import { IMAGE_TEMPLATE_AXES, IMAGE_TEMPLATE_OPTIONS, buildKenBurnsEffect, type ImageTemplateId } from "@/lib/video/imageTemplates";
import { Camera3DRenderer, computeCamera3DPoseForZoomEffect, NEUTRAL_POSE } from "@/lib/video/camera3D";
import { segmentImageApproximate } from "@/lib/video/backgroundSegmentation";
import { CHROMA_KEY_PRESETS, DEFAULT_CHROMA_KEY_COLOR, chromaKeyImageToBitmap, rgbToHex } from "@/lib/video/chromaKey";
import { AMBIENT_EFFECT_OPTIONS, ambientEffectSeed, drawAmbientEffect, type AmbientEffectId } from "@/lib/video/ambientEffects";
import { FACE_EFFECT_OPTIONS, detectFaceGeometry, type FaceEffectId, type FaceGeometry } from "@/lib/video/faceLandmarks";
import { FILTER_PRESET_OPTIONS, getFilterPresetOption, type FilterPresetId } from "@/lib/video/filterPresets";
import { CropRectOverlay } from "./CropRectOverlay";
import {
  DEFAULT_IMAGE_CLIP_DURATION_SECONDS,
  MIN_IMAGE_CLIP_DURATION_SECONDS,
  MAX_IMAGE_CLIP_DURATION_SECONDS,
} from "@/lib/video/transformations";

const PREVIEW_CANVAS_WIDTH = 960;
const PREVIEW_CANVAS_HEIGHT = 540;
const DURATION_STEP_SECONDS = 0.5;
// How close a persisted cropRect's own aspect ratio needs to be to the
// project's CURRENT clip-rectangle ratio to trust it as-is when reopening a
// cutaway for edit -- a wider tolerance would risk reusing a rect authored
// for a since-changed project ratio, silently distorting the photo.
const RATIO_MATCH_TOLERANCE = 0.01;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** A single directional arrow, rotated per template -- pan-left/right/up/down
 * all reuse this one glyph. */
function PanArrowIcon({ direction, className }: { direction: "left" | "right" | "up" | "down"; className?: string }) {
  const rotation = { right: 0, down: 90, left: 180, up: 270 }[direction];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <path d="M4 12h16M13 5l7 7-7 7" />
    </svg>
  );
}

function ZoomIcon({ zoomIn, className }: { zoomIn: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
      {zoomIn ? <path d="M10.5 7.5v6M7.5 10.5h6" /> : <path d="M7.5 10.5h6" />}
    </svg>
  );
}

/** "Pick from photo" eyedropper button icon -- a plain pipette glyph, no
 * per-app custom drawing needed since this is a single fixed icon (unlike
 * TemplateIcon below, which switches on which motion it represents). */
function EyedropperIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M19.5 4.5a2.121 2.121 0 0 0-3-3l-2 2 3 3 2-2Z" />
      <path d="M13.5 6.5 5 15v3h3l8.5-8.5" />
      <path d="M3 21l2-5" />
    </svg>
  );
}

/** Shared by both the Video and Image panels' "Remove background" row --
 * None/Background color/AI removal, mirroring VideoOverlayPickerDialog's own
 * RemovalMode picker so the choice reads the same everywhere it appears.
 * `onPickFromPhoto` is only passed by the Image panel (the Video panel's
 * asset grid has no single large photo to sample a pixel from), so the
 * eyedropper button only renders there. */
function RemovalModePicker({
  mode,
  onModeChange,
  chromaKeyColor,
  onChromaKeyColorChange,
  onPickFromPhoto,
}: {
  mode: "none" | "chromaKey" | "ai";
  onModeChange: (mode: "none" | "chromaKey" | "ai") => void;
  chromaKeyColor: string;
  onChromaKeyColorChange: (hex: string) => void;
  onPickFromPhoto?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted">Background:</span>
      <div className="flex gap-1 rounded-md border border-border p-0.5">
        {([
          { value: "none" as const, label: "Keep" },
          { value: "chromaKey" as const, label: "Solid color" },
          { value: "ai" as const, label: "AI removal" },
        ]).map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onModeChange(option.value)}
            className={
              "rounded-sm px-2 py-1 text-xs font-medium " +
              (mode === option.value ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground")
            }
          >
            {option.label}
          </button>
        ))}
      </div>
      {mode === "chromaKey" && (
        <div className="flex items-center gap-1.5">
          {CHROMA_KEY_PRESETS.map((preset) => (
            <button
              key={preset.hex}
              type="button"
              title={preset.label}
              onClick={() => onChromaKeyColorChange(preset.hex)}
              style={{ backgroundColor: preset.hex }}
              className={
                "h-5 w-5 rounded-full border-2 " +
                (chromaKeyColor === preset.hex ? "border-accent" : "border-transparent")
              }
            />
          ))}
          {onPickFromPhoto && (
            <button
              type="button"
              title="Pick from photo"
              onClick={onPickFromPhoto}
              className="flex h-5 w-5 items-center justify-center rounded-full border border-border text-foreground hover:bg-background"
            >
              <EyedropperIcon className="h-3 w-3" />
            </button>
          )}
          <span
            title={`Current color: ${chromaKeyColor}`}
            style={{ backgroundColor: chromaKeyColor }}
            className="h-5 w-5 rounded-full border border-border"
          />
        </div>
      )}
    </div>
  );
}

/** A compact, always-visible row of filter swatches -- folds
 * FilterPresetDialog's own gallery (opened separately, after a clip's
 * already placed, via the rail's right-click "Filter…") directly into the
 * add/edit flow instead, so a filter is visible and previewed on THIS
 * dialog's own live Ken Burns preview canvas the moment it's picked, same
 * "everything visible in one place" reasoning as this dialog's other
 * effect pickers. Each swatch renders this clip's own thumbnail with that
 * filter's real CSS applied -- the same live-preview approximation
 * CanvasPlayer/exportTimeline use, not just a color chip, so a swatch
 * actually shows what it does. `previewImageSrc` is optional (the Video
 * panel has a small per-asset thumbnail too, unlike the Image panel's own
 * larger live canvas) -- a swatch with none just renders as a plain
 * colored circle, same graceful "no preview yet" fallback FilterPresetDialog
 * itself uses. */
function FilterSwatchPicker({
  value,
  onChange,
  previewImageSrc,
}: {
  value: FilterPresetId | null;
  onChange: (id: FilterPresetId | null) => void;
  previewImageSrc?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted">Filter:</span>
      <div className="flex items-center gap-1 overflow-x-auto">
        {FILTER_PRESET_OPTIONS.map((option) => {
          const isSelected = (value ?? "none") === option.id;
          return (
            <button
              key={option.id}
              type="button"
              title={option.name}
              onClick={() => onChange(option.id === "none" ? null : option.id)}
              className={
                "h-6 w-6 shrink-0 overflow-hidden rounded-full border-2 bg-neutral-800 " +
                (isSelected ? "border-accent" : "border-transparent")
              }
            >
              {previewImageSrc && (
                // eslint-disable-next-line @next/next/no-img-element -- a blob:/data: thumbnail URL, not a Next-optimizable static asset
                <img src={previewImageSrc} alt="" className="h-full w-full object-cover" style={{ filter: option.cssFilter }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TemplateIcon({ id, className }: { id: ImageTemplateId; className?: string }) {
  switch (id) {
    case "zoom-in":
      return <ZoomIcon zoomIn className={className} />;
    case "zoom-out":
      return <ZoomIcon zoomIn={false} className={className} />;
    case "pan-left":
      return <PanArrowIcon direction="left" className={className} />;
    case "pan-right":
      return <PanArrowIcon direction="right" className={className} />;
    case "pan-up":
      return <PanArrowIcon direction="up" className={className} />;
    case "pan-down":
      return <PanArrowIcon direction="down" className={className} />;
  }
}

export function CutawayDialog({
  assets,
  videoThumbnailUrlByAssetId,
  clipRectAspectRatio,
  editing,
  preselectedAssetId,
  onAddImage,
  onAddVideo,
  onClose,
}: {
  assets: Asset[];
  // AssetGallery's own extracted per-video representative still frame --
  // a video asset's own `url` points at the video FILE, not an image, so
  // this is what actually renders in the Video-kind grid below.
  videoThumbnailUrlByAssetId: Record<string, string>;
  /** The project's selected clip-rectangle shape (width/height) -- e.g.
   * ActionArea's playAreaRatio -- the photo's own positioned crop
   * rectangle is locked to this ratio, same as the main clip rectangle. */
  clipRectAspectRatio: number;
  /** Non-null when this dialog was reopened from the Cutaways rail to edit
   * an existing IMAGE cutaway rather than add a fresh one -- pre-populates
   * the panels from its current photo/template(s)/duration/cropRect,
   * relabels the primary button, forces Image kind, and hides the kind
   * switch entirely (a video segment never reopens this dialog -- see
   * CutawayTrack.tsx). */
  editing?: {
    assetId: string;
    templateIds: string[];
    durationSeconds: number;
    cropRect: CropRect | null;
    // Background removal (see this feature's own plan doc) -- pre-selects
    // the removal mode (and, for chroma key, the sampled/preset color) when
    // reopening a cutaway that already has one set, so Save doesn't
    // silently drop it.
    backgroundRemoval?: { enabled: boolean; matteAssetId?: string | null; mode?: "ai" | "chromaKey"; chromaKeyColor?: string } | null;
    // "Make it 3D" (lib/video/camera3D.ts) -- pre-checks the toggle when
    // reopening a cutaway that already has it on, same staging as
    // backgroundRemoval above.
    camera3D?: boolean;
    // Ambient overlay effect (lib/video/ambientEffects.ts) -- pre-selects
    // the picker when reopening a cutaway that already has one set, same
    // staging as camera3D above.
    ambientEffect?: AmbientEffectId | null;
    // Face-locked glow (lib/video/faceLandmarks.ts + camera3D.ts's
    // halo/torus) -- pre-selects the picker when reopening a cutaway that
    // already has one set, same staging as ambientEffect above.
    faceEffect?: FaceEffectId | null;
    // "Pulse with music" (lib/video/audioReactive.ts) -- pre-checks the
    // toggle when reopening a cutaway that already has it on, same staging
    // as camera3D above.
    audioReactive?: boolean;
    // Color filter (lib/video/filterPresets.ts) -- pre-selects the swatch
    // when reopening a cutaway that already has one set (whether authored
    // here or via the rail's own right-click "Filter…"), same staging as
    // camera3D above.
    colorFilterId?: FilterPresetId | null;
  } | null;
  /** Non-null when opened via AssetGallery's right-click "Cutaway" on a
   * specific IMAGE asset -- an ADD, not an edit, just pre-selects that
   * photo instead of defaulting to the first one in the project. */
  preselectedAssetId?: string | null;
  onAddImage: (
    assetId: string,
    durationSeconds: number,
    templateIds: string[],
    cropRect: CropRect,
    options?: {
      removeBackground?: boolean;
      chromaKeyColor?: string;
      camera3D?: boolean;
      ambientEffect?: AmbientEffectId | null;
      faceEffect?: FaceEffectId | null;
      audioReactive?: boolean;
      colorFilterId?: FilterPresetId | null;
    }
  ) => void;
  onAddVideo: (assetId: string, options?: { removeBackground?: boolean; chromaKeyColor?: string; colorFilterId?: FilterPresetId | null }) => void;
  onClose: () => void;
}) {
  // Edit mode is image-only (see the `editing` prop's own comment) -- the
  // kind switch below only ever renders, and only ever matters, in add mode.
  const [kind, setKind] = useState<"video" | "image">("image");
  // Shared between the Video and Image panels -- only one is ever visible
  // at a time (the kind switch above), so one picker covers both, same as
  // the old single "Remove background" checkbox it replaced. Mirrors
  // VideoOverlayPickerDialog's own "none"/"chromaKey"/"ai" RemovalMode.
  const [removalMode, setRemovalMode] = useState<"none" | "chromaKey" | "ai">(
    editing?.backgroundRemoval?.mode === "chromaKey" ? "chromaKey" : editing?.backgroundRemoval?.enabled ? "ai" : "none"
  );
  // Only meaningful when removalMode === "chromaKey" -- a hex color, either
  // one of CHROMA_KEY_PRESETS or sampled directly off the photo via the
  // "Pick from photo" eyedropper below (image panel only; the video panel
  // has no large-enough preview surface to sample from, presets only).
  const [chromaKeyColor, setChromaKeyColor] = useState(editing?.backgroundRemoval?.chromaKeyColor ?? DEFAULT_CHROMA_KEY_COLOR);
  // True while the next click on the displayed photo should sample its
  // pixel color instead of dragging the clip rectangle -- see
  // handlePickColorClick below.
  const [isPickingColor, setIsPickingColor] = useState(false);
  // Color filter (filterPresets.ts) -- same shared-across-panels reasoning
  // as removalMode above (also settable afterward via the rail's own
  // right-click "Filter…", which still opens FilterPresetDialog unchanged
  // for a clip already placed -- this is just the same choice made visible
  // and live-previewed at add-time too, on the Image panel's own preview
  // canvas below).
  const [colorFilterId, setColorFilterId] = useState<FilterPresetId | null>(editing?.colorFilterId ?? null);
  // "Make it 3D" (camera3D.ts) -- image-only, same shared-across-panels
  // reasoning doesn't apply here (video kind has nothing to attach a Ken
  // Burns dolly to), so this is only ever read/shown in the image panel.
  const [camera3D, setCamera3D] = useState(Boolean(editing?.camera3D));
  // Ambient overlay effect (ambientEffects.ts) -- same image-only scoping
  // as camera3D above.
  const [ambientEffect, setAmbientEffect] = useState<AmbientEffectId | null>(editing?.ambientEffect ?? null);
  // Face-locked glow (faceLandmarks.ts + camera3D.ts's halo/torus) -- same
  // image-only scoping as camera3D above, mutually exclusive with itself
  // (pick ONE of "torus"/"halo"/none) but independent of camera3D/
  // ambientEffect.
  const [faceEffect, setFaceEffect] = useState<FaceEffectId | null>(editing?.faceEffect ?? null);
  // "Pulse with music" (audioReactive.ts) -- same image-only scoping as
  // camera3D above. Not previewed in this dialog's own standalone canvas
  // (no background track loaded here) -- it only ever renders once the
  // clip is actually part of the sequence (CanvasPlayer.tsx/exportTimeline.ts).
  const [audioReactive, setAudioReactive] = useState(Boolean(editing?.audioReactive));
  const isEditing = Boolean(editing);

  const imageAssets = assets.filter((asset) => asset.kind === "image");
  const videoAssets = assets.filter((asset) => asset.kind === "video");
  // Photo-picker thumbnails must never load asset.url via a plain <img> --
  // see useCrossOriginImageSrcMap's own comment for why that can poison
  // the browser's cache against CanvasPlayer's later CORS-mode fetch of
  // the exact same URL for the live preview.
  const imageThumbnailSrcById = useCrossOriginImageSrcMap(imageAssets.map((asset) => ({ id: asset.id, url: asset.url })));
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(
    editing?.assetId ?? preselectedAssetId ?? imageAssets[0]?.id ?? null
  );
  const [selectedVideoAssetId, setSelectedVideoAssetId] = useState<string | null>(videoAssets[0]?.id ?? null);
  const [templateIds, setTemplateIds] = useState<ImageTemplateId[]>(
    (editing?.templateIds as ImageTemplateId[] | undefined) ?? [IMAGE_TEMPLATE_OPTIONS[0].id]
  );
  const [durationSeconds, setDurationSeconds] = useState(editing?.durationSeconds ?? DEFAULT_IMAGE_CLIP_DURATION_SECONDS);

  const selectedAsset = imageAssets.find((asset) => asset.id === selectedAssetId) ?? null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  // Camera3DRenderer (camera3D.ts) -- created lazily (most photos never
  // toggle "Make it 3D"), disposed when this dialog unmounts (it always
  // fully remounts on reopen -- see this file's own module comment).
  const camera3DRendererRef = useRef<Camera3DRenderer | null>(null);
  function getCamera3DRenderer(): Camera3DRenderer {
    if (!camera3DRendererRef.current) camera3DRendererRef.current = new Camera3DRenderer();
    return camera3DRendererRef.current;
  }
  useEffect(() => {
    return () => {
      camera3DRendererRef.current?.dispose();
      camera3DRendererRef.current = null;
    };
  }, []);
  // The clip rectangle positioned for THIS photo, as fractions (0..1) of
  // the photo's own naturalWidth/naturalHeight -- null until the photo has
  // loaded and a default (or the persisted rect) has been seeded, see the
  // effect below.
  const [photoCropRect, setPhotoCropRect] = useState<CropRect | null>(null);

  // Loads the selected photo once per asset change, via loadCrossOriginImage
  // rather than a plain <img>/new Image() -- see that function's own module
  // comment for why a plain no-cors load of this exact URL can poison the
  // browser's cache against CanvasPlayer's later CORS-mode fetch of it for
  // the live preview. loadedImage.src ends up being the resulting blob:
  // URL, reused directly below for the static preview <img> too, so this is
  // the only fetch of the photo this dialog ever makes.
  useEffect(() => {
    if (!selectedAsset) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change, same pattern as TranscriptCaptionDialog's own re-sync effect
      setLoadedImage(null);
      return;
    }
    let cancelled = false;
    let ownBlobUrl: string | null = null;
    loadCrossOriginImage(selectedAsset.url)
      .then(({ image, blobUrl }) => {
        if (cancelled) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        ownBlobUrl = blobUrl;
        setLoadedImage(image);
      })
      .catch(() => {
        if (!cancelled) setLoadedImage(null);
      });
    return () => {
      cancelled = true;
      if (ownBlobUrl) URL.revokeObjectURL(ownBlobUrl);
    };
  }, [selectedAsset]);

  // Seeds photoCropRect once the photo's natural size is known: restores
  // the persisted rect when reopening THIS SAME photo for edit (and its
  // aspect ratio still matches the project's current clip-rectangle ratio
  // -- if the project's ratio changed since this cutaway was authored, the
  // stale rect would silently distort the photo, so it's discarded
  // instead), otherwise seeds the max-coverage default for this photo/ratio
  // combination -- same helper ClipRectangleDialog uses for the project's
  // own clip rectangle.
  useEffect(() => {
    if (!loadedImage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change
      setPhotoCropRect(null);
      return;
    }
    const photoAspectRatio = loadedImage.naturalWidth / loadedImage.naturalHeight;
    const persisted = editing && editing.assetId === selectedAssetId ? editing.cropRect : null;
    const persistedRatioMatches =
      persisted != null && Math.abs(persisted.width / persisted.height - clipRectAspectRatio) < RATIO_MATCH_TOLERANCE;
    setPhotoCropRect(persistedRatioMatches ? persisted : computeMaxCoverageCropFraction(photoAspectRatio, clipRectAspectRatio));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `editing` is only read for its value at the moment loadedImage/selectedAssetId change; it can't change mid-lifetime since this dialog fully remounts each time it reopens (see ActionArea's conditional render)
  }, [loadedImage, selectedAssetId, clipRectAspectRatio]);

  // "Make it 3D" foreground/background parallax (see camera3D.ts's own
  // SUBJECT_DEPTH_FRACTION comment) -- an automatic MediaPipe subject cutout
  // for this preview's own drawImage3D call below, recomputed whenever the
  // photo or the toggle itself changes. Also needed (independent of
  // camera3D) whenever the "halo" faceEffect is picked -- its own occlusion
  // trick (camera3D.ts's HALO_DEPTH_FRACTION) depends on this same cutout.
  // Skipped in chromaKey mode -- mirrors CanvasPlayer.tsx's identical
  // backgroundRemoval-enabled scoping (that combination keeps its own flat
  // cutout-over-backdrop treatment instead of a real parallax, see this
  // file's chromaKeyedImage effect below).
  const [subjectCutout, setSubjectCutout] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    if (!loadedImage || removalMode === "chromaKey" || !(camera3D || faceEffect === "halo")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change, same pattern as this file's other re-sync effects
      setSubjectCutout(null);
      return;
    }
    let cancelled = false;
    segmentImageApproximate(loadedImage)
      .then((cutout) => {
        if (!cancelled) setSubjectCutout(cutout);
      })
      .catch((err) => {
        console.error("3D subject cutout failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [loadedImage, camera3D, faceEffect, removalMode]);

  // Face detection (faceLandmarks.ts) for the "Torus above head"/"Halo
  // behind head" pick -- one-shot per photo, same "recomputed whenever the
  // photo or the toggle itself changes" shape as the subject cutout above.
  // Stays null (silently, no console error) when no face is found -- the
  // draw loop below then just skips the faceEffect branch, same "fails
  // toward looks normal" fallback faceLandmarks.ts itself documents. Same
  // chromaKey-mode scoping as subjectCutout above.
  const [faceGeometry, setFaceGeometry] = useState<FaceGeometry | null>(null);
  useEffect(() => {
    if (!loadedImage || !faceEffect || removalMode === "chromaKey") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change, same pattern as this file's other re-sync effects
      setFaceGeometry(null);
      return;
    }
    let cancelled = false;
    detectFaceGeometry(loadedImage)
      .then((geometry) => {
        if (!cancelled) setFaceGeometry(geometry);
      })
      .catch((err) => {
        console.error("Face detection failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [loadedImage, faceEffect, removalMode]);

  // Live chroma-key preview -- unlike AI mode (never actually applied to
  // this dialog's own preview canvas; there's a real matting job to wait on
  // so it isn't worth simulating here), chroma key has nothing to wait on
  // at all, so the draw loop below can show the REAL keyed-out result the
  // instant a preset or the eyedropper picks a color, same instant feedback
  // CanvasPlayer's live preview gives once this cutaway is actually added.
  const [chromaKeyedImage, setChromaKeyedImage] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    if (!loadedImage || removalMode !== "chromaKey") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change, same pattern as this file's other re-sync effects
      setChromaKeyedImage(null);
      return;
    }
    let cancelled = false;
    chromaKeyImageToBitmap(loadedImage, chromaKeyColor)
      .then((bitmap) => {
        if (!cancelled) setChromaKeyedImage(bitmap);
      })
      .catch((err) => {
        console.error("chroma-key preview failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [loadedImage, removalMode, chromaKeyColor]);

  // Backs the "Pick from photo" eyedropper -- redrawn once per photo (not
  // per pick) so a click just re-reads a pixel from an already-drawn
  // canvas rather than re-decoding the image every time.
  const pickCanvasRef = useRef<OffscreenCanvas | null>(null);
  useEffect(() => {
    if (!loadedImage) {
      pickCanvasRef.current = null;
      return;
    }
    const canvas = new OffscreenCanvas(loadedImage.naturalWidth, loadedImage.naturalHeight);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx?.drawImage(loadedImage, 0, 0);
    pickCanvasRef.current = canvas;
  }, [loadedImage]);

  // The photo container (img + CropRectOverlay) is exactly the photo's own
  // aspect ratio (see its own `style={{ aspectRatio: ... }}` below), so
  // object-cover fills it with no letterboxing/cropping to account for --
  // a click's fraction across the CONTAINER is the same fraction across the
  // photo's own natural pixels.
  function handlePickColorClick(e: React.MouseEvent<HTMLDivElement>) {
    const canvas = pickCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const fy = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    const px = Math.min(canvas.width - 1, Math.floor(fx * canvas.width));
    const py = Math.min(canvas.height - 1, Math.floor(fy * canvas.height));
    const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
    setChromaKeyColor(rgbToHex(r, g, b));
    setIsPickingColor(false);
  }

  // Loops the chosen template(s)' combined motion over the loaded image,
  // redrawing every frame -- reuses computeEffectiveCropRect/
  // buildKenBurnsEffect verbatim, the exact math the real added clip will
  // use.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !loadedImage || !photoCropRect) return;

    const zoomEffect = buildKenBurnsEffect(templateIds, photoCropRect, 0, durationSeconds);
    let rafId: number;
    let startTimestamp: number | null = null;

    function draw(timestamp: number) {
      if (startTimestamp === null) startTimestamp = timestamp;
      const elapsedRaw = ((timestamp - (startTimestamp ?? 0)) / 1000) % durationSeconds;
      // Nudged off the exact boundaries -- computeEffectiveCropRect's
      // active-effect check is strictly-between, so t=0 exactly would
      // read as "no effect active" and show the un-animated base rect for
      // one frame every loop.
      const elapsed = clamp(elapsedRaw, 0.001, durationSeconds - 0.001);
      const crop = computeEffectiveCropRect(photoCropRect ?? FULL_FRAME_CROP_RECT, [zoomEffect], elapsed);

      // Non-null: `canvas`/`ctx`/`loadedImage` were all checked just above --
      // TypeScript doesn't carry that narrowing into this nested closure.
      // `crop` is authored against the ORIGINAL photo's own natural
      // dimensions regardless of which source actually gets drawn below --
      // chromaKeyedImage (when present) shares those exact pixel dimensions
      // by construction (see chromaKeyImageToBitmap), so sx/sy/sw/sh stay
      // correct either way.
      const img = loadedImage!;
      const drawSource: HTMLImageElement | ImageBitmap = chromaKeyedImage ?? img;
      const sx = crop.x * img.naturalWidth;
      const sy = crop.y * img.naturalHeight;
      const sw = crop.width * img.naturalWidth;
      const sh = crop.height * img.naturalHeight;
      const dest = computeContainRect(canvas!.width, canvas!.height, crop.width / crop.height);
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      // Color filter (filterPresets.ts) -- set once before either branch
      // below, same "set before the camera3D/plain-draw fork" placement
      // exportTimeline.ts's own per-clip ctx.filter uses, so a filter
      // combines with either path exactly like the real committed clip
      // will (CanvasPlayer.tsx/exportTimeline.ts).
      ctx!.filter = getFilterPresetOption(colorFilterId).cssFilter;
      // "Make it 3D" -- same computeCamera3DPoseForZoomEffect this photo's
      // real committed cutaway will use (CanvasPlayer.tsx/exportTimeline.ts),
      // so this popup's own preview can't drift from the real effect either,
      // same principle buildKenBurnsEffect's own module comment already
      // states for the 2D case.
      // A faceEffect pick routes through the 3D scene even with "Make it 3D"
      // off, via a static NEUTRAL_POSE camera -- see camera3D.ts's own
      // comment on that constant.
      if (camera3D || faceEffect) {
        const pose = camera3D ? computeCamera3DPoseForZoomEffect(zoomEffect, templateIds, elapsed) : NEUTRAL_POSE;
        getCamera3DRenderer().drawImage3D(
          ctx!, drawSource, pose, sx, sy, sw, sh, dest.x, dest.y, dest.width, dest.height, false, false,
          ambientEffect ? { effectId: ambientEffect, elapsedSeconds: elapsed, seed: ambientEffectSeed(selectedAssetId ?? "") } : null,
          subjectCutout,
          faceEffect && faceGeometry ? { effectId: faceEffect, geometry: faceGeometry, elapsedSeconds: elapsed } : null
        );
      } else {
        ctx!.drawImage(drawSource, sx, sy, sw, sh, dest.x, dest.y, dest.width, dest.height);
        // Skipped when camera3D above already rendered this effect inside
        // its own 3D scene (real parallax) -- see that branch's own comment.
        drawAmbientEffect(ctx!, ambientEffect, dest.x, dest.y, dest.width, dest.height, elapsed, ambientEffectSeed(selectedAssetId ?? ""));
      }

      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [loadedImage, templateIds, durationSeconds, photoCropRect, camera3D, ambientEffect, faceEffect, faceGeometry, selectedAssetId, subjectCutout, chromaKeyedImage, colorFilterId]);

  // Toggles one template id, one pick per axis (zoom / horizontal pan /
  // vertical pan) -- picking a second id from the SAME axis as an existing
  // pick swaps it out; picking one from a DIFFERENT axis adds it alongside
  // (combining into one motion). At least one axis stays selected at all
  // times. Re-sorted to IMAGE_TEMPLATE_OPTIONS' own order so the persisted
  // array (and its tooltip/preview) is always deterministic regardless of
  // click order.
  function handleToggleTemplate(id: ImageTemplateId) {
    setTemplateIds((prev) => {
      const axis = IMAGE_TEMPLATE_AXES[id];
      const withoutSameAxis = prev.filter((existingId) => IMAGE_TEMPLATE_AXES[existingId] !== axis);
      const next = prev.includes(id) ? withoutSameAxis : [...withoutSameAxis, id];
      if (next.length === 0) return prev;
      return IMAGE_TEMPLATE_OPTIONS.filter((option) => next.includes(option.id)).map((option) => option.id);
    });
  }

  // Drag-to-stretch the duration bar's right edge -- pointer capture keeps
  // the drag tracking even if the pointer leaves the handle's own bounds.
  const dragStateRef = useRef<{ startClientX: number; startDuration: number } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  function handleDurationHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = { startClientX: e.clientX, startDuration: durationSeconds };
  }
  function handleDurationHandlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    const trackWidthPx = trackRef.current?.clientWidth ?? 1;
    if (!drag) return;
    const deltaSeconds =
      ((e.clientX - drag.startClientX) / trackWidthPx) * (MAX_IMAGE_CLIP_DURATION_SECONDS - MIN_IMAGE_CLIP_DURATION_SECONDS);
    setDurationSeconds(
      clamp(drag.startDuration + deltaSeconds, MIN_IMAGE_CLIP_DURATION_SECONDS, MAX_IMAGE_CLIP_DURATION_SECONDS)
    );
  }
  function handleDurationHandlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    dragStateRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const durationFraction =
    (durationSeconds - MIN_IMAGE_CLIP_DURATION_SECONDS) /
    (MAX_IMAGE_CLIP_DURATION_SECONDS - MIN_IMAGE_CLIP_DURATION_SECONDS);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cutaway"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {isEditing ? "Edit Cutaway" : "Cutaway"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        {!isEditing && (
          <div className="mb-3 flex shrink-0 gap-1 self-start rounded-md border border-border p-0.5">
            {(["image", "video"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={
                  "rounded-sm px-3 py-1 text-xs font-medium capitalize " +
                  (kind === option ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground")
                }
              >
                {option}
              </button>
            ))}
          </div>
        )}

        {/* Panel 1 (18% for image, or the whole body for video) -- asset
            picker for whichever kind is active. */}
        <div
          style={kind === "image" ? { flexBasis: "18%" } : undefined}
          className={"mb-3 flex min-h-0 shrink-0 flex-col gap-1.5 " + (kind === "video" ? "flex-1" : "")}
        >
          <p className="text-[11px] text-muted">{kind === "image" ? "Choose a photo" : "Choose a video"}</p>
          {kind === "image" ? (
            <div className="flex flex-1 items-center gap-2 overflow-x-auto">
              {imageAssets.length === 0 && <p className="text-xs text-muted">No photos in this project yet</p>}
              {imageAssets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  title={asset.filename}
                  onClick={() => setSelectedAssetId(asset.id)}
                  className={
                    "aspect-square h-full shrink-0 overflow-hidden rounded-md border-2 " +
                    (selectedAssetId === asset.id ? "border-accent" : "border-transparent")
                  }
                >
                  {imageThumbnailSrcById[asset.id] && (
                    // eslint-disable-next-line @next/next/no-img-element -- a blob: URL from a safe CORS-mode fetch, not a Next-optimizable static asset
                    <img src={imageThumbnailSrcById[asset.id]} alt={asset.filename} className="h-full w-full object-cover" />
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-1 flex-wrap content-start items-start gap-2 overflow-y-auto">
              {videoAssets.length === 0 && <p className="text-xs text-muted">No videos in this project yet</p>}
              {videoAssets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  title={asset.filename}
                  onClick={() => setSelectedVideoAssetId(asset.id)}
                  className={
                    "aspect-square h-20 shrink-0 overflow-hidden rounded-md border-2 bg-neutral-800 " +
                    (selectedVideoAssetId === asset.id ? "border-accent" : "border-transparent")
                  }
                >
                  {videoThumbnailUrlByAssetId[asset.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a captured video-frame data URL, not a Next-optimizable static asset
                    <img src={videoThumbnailUrlByAssetId[asset.id]} alt={asset.filename} className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-xs text-muted">▶</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {kind === "video" && (
          <div className="flex shrink-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {/* Background removal -- one picker, no separate dialog/menu,
                  matching this app's driving-vision preference for simple
                  controls. "Solid color" keys itself out instantly, entirely
                  client-side, no matter what solid backdrop the footage was
                  shot against (see chromaKey.ts). "AI removal" processing
                  happens after "Add cutaway" (ThreePaneEditor.
                  handleAddToSequence kicks off the actual matting job and
                  polls it), not here -- this picker only records the
                  creator's intent. No eyedropper here (unlike the Image
                  panel) -- this grid's thumbnails are too small to sample a
                  pixel from reliably. */}
              <RemovalModePicker
                mode={removalMode}
                onModeChange={setRemovalMode}
                chromaKeyColor={chromaKeyColor}
                onChromaKeyColorChange={setChromaKeyColor}
              />
              {/* Filter -- same picker as the Image panel's own (see its
                  own comment), previewed against this asset's own captured
                  thumbnail since there's no live animated canvas here to
                  show it on instead. */}
              <FilterSwatchPicker
                value={colorFilterId}
                onChange={setColorFilterId}
                previewImageSrc={selectedVideoAssetId ? videoThumbnailUrlByAssetId[selectedVideoAssetId] : undefined}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border py-1.5 px-3 text-sm font-medium text-foreground hover:bg-background"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!selectedVideoAssetId}
                onClick={() =>
                  selectedVideoAssetId &&
                  onAddVideo(selectedVideoAssetId, {
                    removeBackground: removalMode === "ai",
                    chromaKeyColor: removalMode === "chromaKey" ? chromaKeyColor : undefined,
                    colorFilterId,
                  })
                }
                className="rounded-md bg-accent py-1.5 px-3 text-sm font-medium text-accent-foreground disabled:opacity-50"
              >
                Add cutaway
              </button>
            </div>
          </div>
        )}

        {kind === "image" && (
        <>
        {/* Panel 2 (28%) -- Ken Burns template picker, multi-select: one
            pick per axis, freely combinable across axes. */}
        <div style={{ flexBasis: "28%" }} className="mb-3 flex min-h-0 shrink-0 flex-col gap-1.5">
          <p className="text-[11px] text-muted">Choose one or more motions -- combine, e.g., a zoom with a pan</p>
          <div className="grid flex-1 grid-cols-3 gap-2">
            {IMAGE_TEMPLATE_OPTIONS.map((option) => {
              const isSelected = templateIds.includes(option.id);
              const axisRepresented = templateIds.some(
                (id) => IMAGE_TEMPLATE_AXES[id] === IMAGE_TEMPLATE_AXES[option.id]
              );
              const isAvailableToAdd = !isSelected && !axisRepresented;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => handleToggleTemplate(option.id)}
                  title={isAvailableToAdd ? `${option.name} -- combine with what's already selected` : option.name}
                  className={
                    "flex flex-col items-center justify-center gap-1 rounded-md border-2 bg-background " +
                    (isSelected
                      ? "border-accent"
                      : isAvailableToAdd
                        ? "border-dashed border-accent/50 bg-accent/5"
                        : "border-transparent")
                  }
                >
                  <TemplateIcon id={option.id} className="h-5 w-5 text-foreground" />
                  <span className="text-[10px] text-foreground">{option.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Panel 3 (~55%) -- position the clip rectangle on the actual
            photo (left) alongside the animated preview (right), then the
            duration control below both. */}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex min-h-0 flex-1 gap-2">
            <div className="flex min-h-0 flex-1 flex-col gap-1">
              <p className="text-[11px] text-muted">
                {isPickingColor ? "Click the photo's background color" : "Position the clip rectangle"}
              </p>
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-black">
                {selectedAsset ? (
                  <div
                    className="relative mx-auto h-full max-w-full overflow-hidden"
                    style={loadedImage ? { aspectRatio: `${loadedImage.naturalWidth} / ${loadedImage.naturalHeight}` } : undefined}
                  >
                    {loadedImage && (
                      // eslint-disable-next-line @next/next/no-img-element -- loadedImage.src is a blob: URL from a safe CORS-mode fetch, not a Next-optimizable static asset
                      <img src={loadedImage.src} alt={selectedAsset.filename} className="absolute inset-0 h-full w-full object-cover" />
                    )}
                    {photoCropRect && (
                      <CropRectOverlay cropRect={photoCropRect} onChange={setPhotoCropRect} onCommit={setPhotoCropRect} />
                    )}
                    {isPickingColor && (
                      // Sits on top of CropRectOverlay (later in DOM order),
                      // covering the whole photo at its own exact aspect
                      // ratio -- see handlePickColorClick's own comment for
                      // why a click's fraction across THIS div maps directly
                      // to a fraction of the photo's natural pixels, no
                      // object-cover crop/letterbox math needed.
                      <div
                        onClick={handlePickColorClick}
                        className="absolute inset-0 cursor-crosshair"
                        title="Click to sample this pixel's color"
                      />
                    )}
                  </div>
                ) : (
                  <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                    Choose a photo above
                  </p>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1">
              <p className="text-[11px] text-muted">Preview</p>
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-black">
                {selectedAsset ? (
                  <canvas
                    ref={canvasRef}
                    width={PREVIEW_CANVAS_WIDTH}
                    height={PREVIEW_CANVAS_HEIGHT}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                    Choose a photo above to preview its animation
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setDurationSeconds((d) => clamp(d - DURATION_STEP_SECONDS, MIN_IMAGE_CLIP_DURATION_SECONDS, MAX_IMAGE_CLIP_DURATION_SECONDS))}
              className="h-6 w-6 shrink-0 rounded-md border border-border text-sm text-foreground hover:bg-background"
              aria-label="Shorten duration"
            >
              −
            </button>

            <div ref={trackRef} className="relative h-2 flex-1 rounded-full bg-neutral-800">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-accent"
                style={{ width: `${durationFraction * 100}%` }}
              />
              <div
                onPointerDown={handleDurationHandlePointerDown}
                onPointerMove={handleDurationHandlePointerMove}
                onPointerUp={handleDurationHandlePointerUp}
                className="absolute top-1/2 h-4 w-4 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-accent bg-background"
                style={{ left: `calc(${durationFraction * 100}% - 8px)` }}
              />
            </div>

            <button
              type="button"
              onClick={() => setDurationSeconds((d) => clamp(d + DURATION_STEP_SECONDS, MIN_IMAGE_CLIP_DURATION_SECONDS, MAX_IMAGE_CLIP_DURATION_SECONDS))}
              className="h-6 w-6 shrink-0 rounded-md border border-border text-sm text-foreground hover:bg-background"
              aria-label="Lengthen duration"
            >
              +
            </button>

            <span className="w-10 shrink-0 text-right text-xs text-muted">{durationSeconds.toFixed(1)}s</span>
          </div>

          <div className="mt-1 flex flex-col gap-2">
            {/* Background removal, same picker as the Video panel's own
                (see its own comment) -- "AI removal" for a photo runs a
                synchronous image-matting job (backend/src/matting/
                service.py's image-kind path) rather than VEED's async video
                job, but the creator-facing control is identical either way.
                Unlike the Video panel, this one gets the eyedropper -- the
                photo is right there in Panel 3 above to sample a pixel
                from. Its own row -- it can grow wide (swatches + eyedropper
                + current-color chip), so it no longer has to jostle for
                space against the effect toggles below. */}
            <RemovalModePicker
              mode={removalMode}
              onModeChange={setRemovalMode}
              chromaKeyColor={chromaKeyColor}
              onChromaKeyColorChange={setChromaKeyColor}
              onPickFromPhoto={() => setIsPickingColor(true)}
            />

            {/* Look & motion -- every effect that's purely cosmetic on top
                of the motion/crop already authored above, grouped into one
                wrapping row now that Filter lives here too instead of only
                ever being reachable afterward via the rail's right-click
                "Filter…". */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {/* Color filter (filterPresets.ts) -- previewed live on
                  Panel 3's own animated canvas above the instant a swatch
                  is picked. */}
              <FilterSwatchPicker
                value={colorFilterId}
                onChange={setColorFilterId}
                previewImageSrc={selectedAsset ? imageThumbnailSrcById[selectedAsset.id] : undefined}
              />
              {/* "Make it 3D" (camera3D.ts) -- real dolly + tilt + roll
                  camera motion layered on top of whichever motion(s) are
                  picked above, rather than a separate effect with its own
                  controls (see this app's driving-vision preference for
                  smart defaults over exposed knobs). */}
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={camera3D}
                  onChange={(e) => setCamera3D(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Make it 3D
              </label>
              {/* Ambient overlay effect (ambientEffects.ts) -- a subtle
                  looping overlay composited on top of the motion above,
                  independent of "Make it 3D" (works with either). No per-
                  effect tuning, same "no exposed knobs" reasoning as
                  camera3D. */}
              <label className="flex items-center gap-1.5 text-xs text-muted">
                Ambience
                <select
                  value={ambientEffect ?? ""}
                  onChange={(e) => setAmbientEffect((e.target.value || null) as AmbientEffectId | null)}
                  className="rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground"
                >
                  <option value="">None</option>
                  {AMBIENT_EFFECT_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id} title={option.description}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {/* Face-locked glow (faceLandmarks.ts + camera3D.ts) -- a
                  mutually-exclusive pick, like Ambience above, independent
                  of "Make it 3D"/Ambience (all combine freely). A no-op
                  when no face is detected in the photo. */}
              <label className="flex items-center gap-1.5 text-xs text-muted">
                Face effect
                <select
                  value={faceEffect ?? ""}
                  onChange={(e) => setFaceEffect((e.target.value || null) as FaceEffectId | null)}
                  className="rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground"
                >
                  <option value="">None</option>
                  {FACE_EFFECT_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id} title={option.description}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {/* "Pulse with music" (audioReactive.ts) -- subtly scales this
                  cutaway to the project's background-music amplitude,
                  independent of "Make it 3D"/Ambience above (all three
                  combine freely). A no-op when no background track is
                  selected. */}
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={audioReactive}
                  onChange={(e) => setAudioReactive(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Pulse with music
              </label>
            </div>

            {/* Removing an already-placed cutaway is the rail's own
                right-click "Remove Cutaway" (CutawayTrack.tsx) -- no second
                copy of that action needed here. */}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border py-1.5 px-3 text-sm font-medium text-foreground hover:bg-background"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!selectedAsset || !photoCropRect}
                onClick={() =>
                  selectedAsset &&
                  photoCropRect &&
                  onAddImage(selectedAsset.id, durationSeconds, templateIds, photoCropRect, {
                    removeBackground: removalMode === "ai",
                    chromaKeyColor: removalMode === "chromaKey" ? chromaKeyColor : undefined,
                    camera3D,
                    ambientEffect,
                    faceEffect,
                    audioReactive,
                    colorFilterId,
                  })
                }
                className="rounded-md bg-accent py-1.5 px-3 text-sm font-medium text-accent-foreground disabled:opacity-50"
              >
                {isEditing ? "Save changes" : "Add cutaway"}
              </button>
            </div>
          </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
