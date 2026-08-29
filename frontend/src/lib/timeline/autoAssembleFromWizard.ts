import type { Asset } from "@/lib/api";
import { loadImageElement } from "@/lib/image";
import { DEFAULT_EDIT_SELECTIONS, type EditSelectionsSnapshot } from "@/lib/projects";
import type { ImageTemplateId } from "@/lib/video/imageTemplates";
import {
  applyAddImageSequenceClip,
  applyAddSequenceClip,
  DEFAULT_IMAGE_CLIP_DURATION_SECONDS,
} from "@/lib/video/transformations";
import { getVideoDuration } from "@/lib/video/video";
import {
  computeMaxCoverageCropFraction,
  DEFAULT_TEXT_OVERLAY_RECT,
  FULL_FRAME_CROP_RECT,
  type CropRect,
  type TextOverlay,
  type TtsOverlay,
} from "@/lib/video/video_math";

// Matches the wizard's fixed 9:16 output (same as lib/timeline/resolve.ts's
// createEmptyReelTimeline) -- used only to pick each photo's default crop
// rect; the user can still change the project's own aspect ratio afterward
// in the editor, which just re-targets these same crop rects.
const TARGET_ASPECT_RATIO = 1080 / 1920;

// One Ken Burns move per media slot, cycling if there are more slots than
// entries here -- gives an auto-assembled reel some visual variety (not
// every clip zooming in the same way) without asking the wizard user to
// pick a motion per photo themselves.
const KEN_BURNS_ROTATION: ImageTemplateId[][] = [["zoom-in"], ["pan-left"], ["pan-right"], ["zoom-out"]];

const HOOK_OVERLAY_DURATION_SECONDS = 2.5;
const CTA_OVERLAY_DURATION_SECONDS = 3;
// Upper third, clear of both the hook's own template chrome and wherever a
// creator might later add a transcript caption (bottom third's the
// caption-safe zone -- see video_math.ts's DEFAULT_TEXT_OVERLAY_RECT).
const HOOK_RECT: CropRect = { x: 0.08, y: 0.06, width: 0.84, height: 0.16 };
// A thin strip right at the bottom edge, below the standard bottom-third
// caption zone (DEFAULT_TEXT_OVERLAY_RECT starts at y: 0.7) -- reads as a
// persistent lower-third contact bar rather than competing with captions or
// the end-screen CTA below.
const CONTACT_RECT: CropRect = { x: 0.04, y: 0.9, width: 0.92, height: 0.08 };

export interface WizardSlotAsset {
  slotKey: string;
  asset: Asset;
}

export interface WizardOverlayInputs {
  /** Already interpolated (placeholders resolved) -- shown for the first
   * couple of seconds, like the real-estate spec's "hook" concept. */
  hookText?: string | null;
  /** Already composed (e.g. "Jane Doe • 98765 43210") -- shown for the
   * whole reel as a lower-third contact bar. */
  contactLine?: string | null;
  /** Already interpolated -- shown only in the final few seconds, as an
   * end-screen call to action (e.g. a comment-keyword lead magnet). */
  ctaText?: string | null;
  /** A talking-avatar video (HeyGen, lip-synced to the niche's narration
   * script -- see dashboard/(chrome)/new/page.tsx's handleGenerate) that
   * already has the narration baked into its own audio track. Prepended as
   * the reel's own FIRST clip (an intro, like a realtor's own on-camera
   * pitch before the listing tour) rather than an overlay -- reuses the
   * exact same sequence-clip mechanism as a media-slot video, and every
   * later clip's start time simply shifts by however long it runs. Takes
   * priority over `narration` below when both are given, since playing
   * both would double the narration audio. */
  avatarClipAsset?: { id: string; url: string } | null;
  /** Audio-only narration (no avatar video available/chosen, or avatar
   * generation failed/timed out) -- a fully-synthesized TTS overlay
   * (already generated via synthesizeTts + re-probed for its real
   * duration). Placed at t=0 with whatever displayMode/rect it already
   * carries. Ignored if `avatarClipAsset` is set. */
  narration?: TtsOverlay | null;
}

/** Builds a real, editable starting point for the desktop/mobile editor
 * from the wizard's collected inputs -- every media slot becomes its own
 * sequence clip (Ken Burns-animated if it's a photo), followed by whichever
 * overlays the wizard collected. Returns the SAME EditSelectionsSnapshot
 * shape ThreePaneEditor/MobileEditor already edit, built via the exact same
 * transformation functions the editor's own "Add to video"/"Add text" UI
 * uses (applyAddImageSequenceClip et al.) -- so what the wizard hands off
 * is indistinguishable from a reel a user assembled by hand, and every
 * existing editor feature (including the Render vs Edge Render choice)
 * just works on it unchanged. */
export async function autoAssembleFromWizard(
  slotAssets: WizardSlotAsset[],
  overlays: WizardOverlayInputs = {}
): Promise<EditSelectionsSnapshot> {
  let selections: EditSelectionsSnapshot = DEFAULT_EDIT_SELECTIONS;
  let runningTimeSeconds = 0;
  let imageIndex = 0;

  if (overlays.avatarClipAsset) {
    selections = applyAddSequenceClip(selections, overlays.avatarClipAsset.id).state;
    try {
      runningTimeSeconds += await getVideoDuration(overlays.avatarClipAsset.url);
    } catch {
      runningTimeSeconds += DEFAULT_IMAGE_CLIP_DURATION_SECONDS;
    }
  }

  for (const { asset } of slotAssets) {
    if (asset.kind === "video") {
      selections = applyAddSequenceClip(selections, asset.id).state;
      try {
        runningTimeSeconds += await getVideoDuration(asset.url);
      } catch {
        // Duration probe can fail on an unsupported codec/slow decode --
        // fall back to a flat estimate rather than leaving later image
        // clips' Ken Burns timing off by an unknown amount.
        runningTimeSeconds += DEFAULT_IMAGE_CLIP_DURATION_SECONDS;
      }
      continue;
    }

    let cropRect: CropRect = FULL_FRAME_CROP_RECT;
    try {
      const image = await loadImageElement(asset.url);
      cropRect = computeMaxCoverageCropFraction(image.naturalWidth / image.naturalHeight, TARGET_ASPECT_RATIO);
    } catch {
      // Falls back to the full frame if the photo can't be decoded for its
      // dimensions -- still a valid (if uncropped) clip, not a failure.
    }

    const templateIds = KEN_BURNS_ROTATION[imageIndex % KEN_BURNS_ROTATION.length];
    selections = applyAddImageSequenceClip(
      selections,
      asset.id,
      DEFAULT_IMAGE_CLIP_DURATION_SECONDS,
      templateIds,
      cropRect,
      runningTimeSeconds
    ).state;
    runningTimeSeconds += DEFAULT_IMAGE_CLIP_DURATION_SECONDS;
    imageIndex += 1;
  }

  const totalDurationSeconds = runningTimeSeconds;
  const textOverlays: TextOverlay[] = [];

  if (overlays.hookText) {
    textOverlays.push({
      text: overlays.hookText,
      templateId: "bold-pop",
      startTimeSeconds: 0,
      endTimeSeconds: Math.min(HOOK_OVERLAY_DURATION_SECONDS, totalDurationSeconds || HOOK_OVERLAY_DURATION_SECONDS),
      rect: HOOK_RECT,
    });
  }

  if (overlays.contactLine && totalDurationSeconds > 0) {
    textOverlays.push({
      text: overlays.contactLine,
      templateId: "minimal-subtitle",
      startTimeSeconds: 0,
      endTimeSeconds: totalDurationSeconds,
      rect: CONTACT_RECT,
    });
  }

  if (overlays.ctaText && totalDurationSeconds > 0) {
    textOverlays.push({
      text: overlays.ctaText,
      templateId: "highlight-box",
      startTimeSeconds: Math.max(0, totalDurationSeconds - CTA_OVERLAY_DURATION_SECONDS),
      endTimeSeconds: totalDurationSeconds,
      rect: DEFAULT_TEXT_OVERLAY_RECT,
    });
  }

  const ttsOverlays: TtsOverlay[] = !overlays.avatarClipAsset && overlays.narration ? [overlays.narration] : [];

  return { ...selections, textOverlays, ttsOverlays };
}
