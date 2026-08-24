"use client";

/**
 * Four vertical tab triggers, all the same shape: an icon, a rotated
 * label, and a click that opens a modal owned by ActionArea (none of them
 * expand inline -- picking a clip rectangle, adding a caption, or
 * animating a photo all need more room than a narrow side panel can hold).
 * "Clip" is the odd one out only in that its modal (ClipRectangleDialog)
 * applies a choice the instant it's clicked rather than needing a save
 * step, so once something's selected this tab also grows a small preview
 * swatch of it at the bottom, the only at-a-glance state any of these four
 * tabs surface without opening their dialog.
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
 * its own click-to-cut gray/red line above the frames (TrimTrack.tsx).
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
// the "animate a photo" trigger from a plain picture glyph.
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

export function UserActions({
  selectedClipRectId,
  onOpenClipRectDialog,
  onOpenTextDialog,
  onOpenTranscriptDialog,
  onOpenImageTemplatesDialog,
}: {
  selectedClipRectId: string | null;
  onOpenClipRectDialog: () => void;
  onOpenTextDialog: () => void;
  onOpenTranscriptDialog: () => void;
  onOpenImageTemplatesDialog: () => void;
}) {
  const selectedClipRectOption = CLIP_RECT_OPTIONS.find((option) => option.id === selectedClipRectId) ?? null;
  return (
    <div className="flex h-full gap-3 overflow-x-auto">
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
        onClick={onOpenTextDialog}
        title="Add text"
        className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pt-2 text-muted hover:bg-background"
      >
        <TextGlyphIcon className="h-4 w-4" />
        <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
          Text
        </span>
      </button>
      <button
        type="button"
        onClick={onOpenTranscriptDialog}
        title="Auto-captions"
        className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pt-2 text-muted hover:bg-background"
      >
        <ClosedCaptionIcon className="h-4 w-4" />
        <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
          Auto-Caption
        </span>
      </button>
      <button
        type="button"
        onClick={onOpenImageTemplatesDialog}
        title="Animate a photo"
        className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pt-2 text-muted hover:bg-background"
      >
        <ImageMotionIcon className="h-4 w-4" />
        <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
          Image
        </span>
      </button>
    </div>
  );
}
