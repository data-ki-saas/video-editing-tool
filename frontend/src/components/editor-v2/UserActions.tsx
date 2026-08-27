"use client";

/**
 * Vertical tab triggers, all the same shape: an icon, a rotated label, and
 * a click that opens a modal owned by ActionArea (none of them expand
 * inline -- picking a clip rectangle, adding a caption, or animating a
 * photo all need more room than a narrow side panel can hold). "Clip" is
 * the odd one out only in that its modal (ClipRectangleDialog) applies a
 * choice the instant it's clicked rather than needing a save step, so once
 * something's selected this tab also grows a small preview swatch of it at
 * the bottom. The other tabs pin their own at-a-glance state to the same
 * bottom spot: Cutaway/Video Overlay/Image Overlay/Text show a count badge
 * once they have at least one item (CountBadge), Auto-Caption shows a
 * filled On/Off pill instead since it's a single whole-video setting, not a
 * count (AutoCaptionStatus).
 *
 * Grouped into three clusters, left to right, each with its own micro
 * uppercase label (same convention AssetGallery.tsx's own section headers
 * use) so the tab bar reads as organized roles rather than one flat row:
 *  - BASE: Clip, Cutaway -- what the base sequence itself is made of. Plain/
 *    untinted icons.
 *  - OVERLAYS: Video Overlay, Image Overlay, Text -- what composites ON TOP
 *    of the base. Video Overlay's icon is tinted amber (matching its rail's
 *    dominant Full-Screen color, VideoOverlayTrack.tsx), Image Overlay's is
 *    tinted sky (matching ImageOverlayTrack.tsx's own palette) -- distinct
 *    hue families so the two read as different overlay kinds at a glance,
 *    same as their rails already do.
 *  - CAPTIONS: Auto-Caption -- its own cluster since it's a different kind
 *    of thing (server-side transcription, not a user-placed clip/overlay).
 *
 * There is no separate "Transform" or "Arrange" menu (Zoom In/Out, Pan &
 * Tilt, Flip, Mirror, Delete, Trim, Drag) -- the clip rectangle is the
 * clip's fixed property, and every transform is a manipulation of it (or
 * of the timeline itself) directly: Crop is automatic (picking a ratio
 * places it), Zoom/Pan happen by dragging/resizing the clip rectangle at a
 * different point on the timeline (see ThreePaneEditor's
 * handleCropRectCommit -- the resulting transition only ever applies
 * within its own range on ZoomEffectsTrack below the frames, not past it),
 * Flip/Mirror toggle from CropRectOverlay's own edge handles, and Trim is
 * its own click-to-cut gray/red line above the frames -- the Cut and Trim
 * rail (TrimTrack.tsx). "Cutaway" (this file's "Cutaway" tab) covers both
 * a video clip and a Ken-Burns-animated photo appended to the base
 * sequence, and gets its own rail too, the Cutaways rail (CutawayTrack.tsx),
 * stacked directly above the Cut and Trim rail.
 */
import { CropToolIcon } from "@/components/icons/UIIcons";
import { CLIP_RECT_OPTIONS, ClipRectIcon } from "./ClipRectIcon";

function TextGlyphIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className}>
      <path d="M5 6h14M12 6v13" />
    </svg>
  );
}

// Universal "closed captions" glyph -- distinguishes the auto-caption
// trigger from the plain "Text" one at a glance.
function ClosedCaptionIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      <text x="12" y="14.5" textAnchor="middle" fontSize="7" fontWeight="700" stroke="none" fill="currentColor">
        CC
      </text>
    </svg>
  );
}

// A photo frame with a small motion trail on its corner -- distinguishes
// the "insert a cutaway" trigger from a plain picture glyph, and from
// PhotoOverlayIcon below (a static corner box, not a trail) -- "this one
// moves."
function ImageMotionIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
      <rect x="2.5" y="4.5" width="14" height="14" rx="2" />
      <circle cx="7.5" cy="9.5" r="1.4" fill="currentColor" stroke="none" />
      <path d="M4 16l4-4 3 3 4-5 2 2" />
      <path d="M18.5 8.5c1.8 1.2 2.5 3 1.8 5" strokeLinecap="round" />
      <path d="M19 6.7l1.6 1.4-2 .8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A small box overlapping a big box -- the universal Picture-in-Picture
// glyph, used here as "Video Overlay" 's identity regardless of which
// layout (Full-Screen/PiP/Split-Screen) is actually active on any given
// placement, tinted amber to match that rail's dominant Full-Screen color.
function VideoOverlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
      <rect x="2.5" y="4.5" width="19" height="13" rx="1.5" />
      <rect x="13" y="11.5" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// A photo frame with a small overlapping corner box (a STATIC box, not a
// motion trail -- unlike ImageMotionIcon) -- "Image Overlay" 's identity,
// tinted sky to read as a distinct family from Video Overlay's amber.
function PhotoOverlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
      <rect x="2.5" y="4.5" width="14" height="14" rx="2" />
      <circle cx="7.5" cy="9.5" r="1.4" fill="currentColor" stroke="none" />
      <path d="M4 16l4-4 3 3 4-5 2 2" />
      <rect x="13" y="11.5" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Small notification-style count badge, pinned to the bottom of a tab
// trigger once it has at least one item -- the at-a-glance equivalent of
// Clip's own preview swatch (also bottom-pinned via mt-auto) for the tabs
// that don't have a single swatch-able value to show instead.
function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="mt-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-medium leading-none text-accent-foreground">
      {count}
    </span>
  );
}

// Auto-Caption has no "count" that means anything (it's one config for the
// whole video, on or off) -- a filled on/white-text pill reads clearly
// against any of the app's light/dark/color themes, unlike plain colored
// text sitting directly on the page background.
function AutoCaptionStatus({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`mt-auto rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none text-white ${
        enabled ? "bg-green-600" : "bg-red-600"
      }`}
    >
      {enabled ? "On" : "Off"}
    </span>
  );
}

// A tab's own group micro-label, shared across every group below -- same
// tiny uppercase convention AssetGallery.tsx's own section headers use.
function GroupLabel({ children }: { children: React.ReactNode }) {
  return <p className="pointer-events-none absolute -top-4 left-0 whitespace-nowrap text-[9px] font-medium uppercase tracking-wide text-muted">{children}</p>;
}

export function UserActions({
  selectedClipRectId,
  onOpenClipRectDialog,
  onOpenCutawayDialog,
  cutawayCount,
  onOpenVideoOverlayPicker,
  videoOverlayCount,
  onOpenImageOverlayPicker,
  imageOverlayCount,
  onOpenTextDialog,
  textOverlayCount,
  onOpenTranscriptDialog,
  autoCaptionEnabled,
}: {
  selectedClipRectId: string | null;
  onOpenClipRectDialog: () => void;
  onOpenCutawayDialog: () => void;
  cutawayCount: number;
  onOpenVideoOverlayPicker: () => void;
  videoOverlayCount: number;
  onOpenImageOverlayPicker: () => void;
  imageOverlayCount: number;
  onOpenTextDialog: () => void;
  textOverlayCount: number;
  onOpenTranscriptDialog: () => void;
  autoCaptionEnabled: boolean;
}) {
  const selectedClipRectOption = CLIP_RECT_OPTIONS.find((option) => option.id === selectedClipRectId) ?? null;
  return (
    <div className="flex h-full items-stretch gap-4 overflow-x-auto pt-4">
      {/* BASE */}
      <div className="relative flex h-full gap-3">
        <GroupLabel>Base</GroupLabel>
        <button
          type="button"
          onClick={onOpenClipRectDialog}
          title="Clip rectangle"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-muted hover:bg-background"
        >
          <CropToolIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Clip
          </span>
          {selectedClipRectOption && (
            <span className="mt-auto text-foreground" title={`${selectedClipRectOption.name} -- ${selectedClipRectOption.ratioLabel}`}>
              <ClipRectIcon option={selectedClipRectOption} size={16} />
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onOpenCutawayDialog}
          title="Add a Cutaway -- a video clip or an animated photo, appended to the reel"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-muted hover:bg-background"
        >
          <ImageMotionIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Cutaway
          </span>
          <CountBadge count={cutawayCount} />
        </button>
      </div>

      {/* OVERLAYS */}
      <div className="relative flex h-full gap-3">
        <GroupLabel>Overlays</GroupLabel>
        <button
          type="button"
          onClick={onOpenVideoOverlayPicker}
          title="Video Overlay -- a second video on its own switchable Full-Screen/Picture-in-Picture/Split Screen layer"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-amber-600 hover:bg-background"
        >
          <VideoOverlayIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Video Overlay
          </span>
          <CountBadge count={videoOverlayCount} />
        </button>
        <button
          type="button"
          onClick={onOpenImageOverlayPicker}
          title="Image Overlay -- a photo on its own switchable Full-Screen/Picture-in-Picture/Split Screen layer"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-sky-600 hover:bg-background"
        >
          <PhotoOverlayIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Image Overlay
          </span>
          <CountBadge count={imageOverlayCount} />
        </button>
        <button
          type="button"
          onClick={onOpenTextDialog}
          title="Add text"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-muted hover:bg-background"
        >
          <TextGlyphIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Text
          </span>
          <CountBadge count={textOverlayCount} />
        </button>
      </div>

      {/* CAPTIONS */}
      <div className="relative flex h-full gap-3">
        <GroupLabel>Captions</GroupLabel>
        <button
          type="button"
          onClick={onOpenTranscriptDialog}
          title="Auto-captions"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-muted hover:bg-background"
        >
          <ClosedCaptionIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Auto-Caption
          </span>
          <AutoCaptionStatus enabled={autoCaptionEnabled} />
        </button>
      </div>
    </div>
  );
}
