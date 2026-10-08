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
 * bottom spot: Cutaway/Images & Videos/Text show a count badge
 * once they have at least one item (CountBadge).
 *
 * Grouped into two clusters, left to right, each with its own micro
 * uppercase label (same convention AssetGallery.tsx's own section headers
 * use) so the tab bar reads as organized roles rather than one flat row.
 * Each cluster owns exactly one fixed hue (also tinting its own GroupLabel,
 * so the label reads as that group's color key), and every tab inside it
 * gets its own shade of that same hue -- lightest for the first tab,
 * darkest for the last -- so a tab's color says both "which group" (hue)
 * and "which one within it" (shade) at a glance, rather than an unrelated
 * hue per tab:
 *  - BASE (blue): Clip, Thumbnail, Cutaway, Text Slide -- what the base
 *    sequence itself is made of (plus Thumbnail, a fixed property of the
 *    reel as a whole -- see its own note below). Color filters are no
 *    longer a whole-clip setting here -- each cutaway (Cutaways rail,
 *    CutawayTrack.tsx) and each overlay (ImageOverlayTrack.tsx/
 *    VideoOverlayTrack.tsx) gets its own, via that clip's own right-click
 *    "Filter".
 *  - OVERLAYS (amber): Images & Videos, Text, TTS, Avatar --
 *    what composites ON TOP of the base. All five share the same amber
 *    family now (previously each had its own unrelated hue -- amber/sky/
 *    violet -- which read as unrelated colors rather than one "overlays"
 *    group); shade alone now distinguishes them within the cluster.
 *
 * Thumbnail (moved here from the top bar -- it's an editing decision about
 * this reel's own content, not a global nav/render action) sits in BASE
 * right after Clip: it isn't a clip/overlay added to the timeline like the
 * other tabs, but it's still a fixed property of the reel as a whole, same
 * category as Clip. It follows Clip's own convention of a bottom-pinned
 * preview swatch (the picked frame) instead of a CountBadge, since there's
 * only ever one thumbnail, not a count of them.
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
import { CoverIcon } from "./icons/PlayerIcons";
import { CLIP_RECT_OPTIONS, ClipRectIcon } from "./ClipRectIcon";
import { NEW_CUTAWAY_DRAG_TYPE } from "./CutawayTrack";
import { HelpTip } from "./HelpTip";

// A capsule split into two colour blocks (one filled, one outlined) -- the
// "Label" button's identity, echoing the two-tone price/name labels it adds.
function LabelGlyphIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className}>
      <rect x="2.5" y="7.5" width="19" height="9" rx="4.5" />
      <path d="M10 7.5v9" />
      <path d="M4.5 12h3" />
    </svg>
  );
}

// A photo frame with a small motion trail on its corner -- distinguishes
// the "insert a cutaway" trigger from a plain picture glyph -- "this one
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

// A card with two text lines inside -- "Text Slide" 's identity, distinct
// from TextGlyphIcon's bare "T" (a manually-typed caption over existing
// footage): this one is its own full-frame slide, not an overlay on top of
// anything.
function TextSlideIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className}>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="M7 10.5h10M7 14.5h6" />
    </svg>
  );
}

// A small box overlapping a big box -- the universal Picture-in-Picture
// glyph, used here as "Images & Videos" 's identity regardless of which
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

// A little crate/cube -- "Props" 's identity: a physical thing you set down in
// the scene, distinct from Overlay's picture-in-picture glyph.
function PropsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3 20.5 7.5v9L12 21 3.5 16.5v-9L12 3Z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </svg>
  );
}

// A smiling face -- "Peeps" 's identity: a character you build, distinct from
// Props' crate and Avatar's framed silhouette.
function PeepsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5c1 1.4 2.2 2 3.5 2s2.5-.6 3.5-2" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </svg>
  );
}

// Speech bubble with a small waveform inside -- "TTS Narration" 's identity,
// tinted violet to read as its own distinct family from Text's plain/
// untinted glyph, Video Overlay's amber, and Image Overlay's sky.
function TtsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 5.5h16a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H9l-4 3.5V16H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z" />
      <path d="M8.5 8.5v4M12 7.5v6M15.5 9v3" />
    </svg>
  );
}

// A simple person silhouette in a rounded frame -- "Avatar" 's identity,
// distinct from every other Overlays-cluster glyph above (none of them are
// a character), same darkest-shade-last convention as this cluster's own
// module comment describes.
function AvatarPersonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2.5" y="3.5" width="19" height="17" rx="2" />
      <circle cx="12" cy="10" r="2.8" />
      <path d="M6.5 17c0-2.9 2.5-5 5.5-5s5.5 2.1 5.5 5" />
    </svg>
  );
}

// A magic wand with a spark -- "Reel Wizard" 's identity (guided, generates a
// whole starting reel), distinct from every Base/Overlays glyph.
function WizardIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 20 15 9" />
      <path d="m14 6 4 4" />
      <path d="M18 3v3M16.5 4.5h3M20 12v2M19 13h2" />
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

// A tab's own group micro-label, shared across every group below -- same
// tiny uppercase convention AssetGallery.tsx's own section headers use.
// `colorClassName` ties the label to its group's own fixed hue (see this
// file's module comment), so the label doubles as that group's color key.
// `help` adds a "?" popover beside the label (see HelpTip.tsx) -- the label
// text itself stays click-through, only the "?" takes pointer events.
function GroupLabel({
  children,
  colorClassName,
  help,
}: {
  children: React.ReactNode;
  colorClassName: string;
  help?: { id: string; title: string; body: React.ReactNode };
}) {
  return (
    <div className={`absolute -top-4 left-0 flex items-center gap-1 whitespace-nowrap ${colorClassName}`}>
      <p className="pointer-events-none text-[9px] font-medium uppercase tracking-wide">{children}</p>
      {help && (
        <HelpTip id={help.id} title={help.title} className="h-3 w-3 text-[8px]">
          {help.body}
        </HelpTip>
      )}
    </div>
  );
}

export function UserActions({
  onOpenNewReelWizard,
  selectedClipRectId,
  onOpenClipRectDialog,
  onOpenCutawayDialog,
  cutawayCount,
  onOpenTextSlideDialog,
  textSlideCount,
  onOpenOverlayPicker,
  overlayCount,
  onOpenPropsDialog,
  onOpenPeepsDialog,
  onOpenTextDialog,
  textOverlayCount,
  onOpenTtsDialog,
  ttsOverlayCount,
  onOpenAvatarDialog,
  avatarOverlayCount,
  onOpenCoverPicker,
  coverThumbnailUrl,
}: {
  onOpenNewReelWizard: () => void;
  selectedClipRectId: string | null;
  onOpenClipRectDialog: () => void;
  onOpenCutawayDialog: () => void;
  cutawayCount: number;
  onOpenTextSlideDialog: () => void;
  textSlideCount: number;
  onOpenOverlayPicker: () => void;
  // Video and photo overlays together -- one button covers both.
  overlayCount: number;
  onOpenPropsDialog: () => void;
  onOpenPeepsDialog: () => void;
  onOpenTextDialog: () => void;
  textOverlayCount: number;
  onOpenTtsDialog: () => void;
  ttsOverlayCount: number;
  onOpenAvatarDialog: () => void;
  avatarOverlayCount: number;
  onOpenCoverPicker: () => void;
  coverThumbnailUrl: string | null;
}) {
  const selectedClipRectOption = CLIP_RECT_OPTIONS.find((option) => option.id === selectedClipRectId) ?? null;
  return (
    <div className="flex h-full items-stretch gap-4 overflow-x-auto pt-4">
      {/* WIZARD -- emerald; opens the guided new-reel flow as a modal (it creates its own draft reel, then navigates to it on finish) */}
      <div className="relative flex h-full gap-3">
        <GroupLabel
          colorClassName="text-emerald-600 dark:text-emerald-400"
          help={{
            id: "tools-wizard",
            title: "Reel Wizard",
            body: (
              <p>
                Not sure where to begin? Answer a few questions about your business and the wizard assembles a
                starting reel for you. You can then tweak anything it made.
              </p>
            ),
          }}
        >
          Wizard
        </GroupLabel>
        <button
          type="button"
          onClick={onOpenNewReelWizard}
          title="Reel Wizard -- answer a few questions and get a starting reel assembled for you"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-emerald-600 dark:text-emerald-400 hover:bg-background"
        >
          <WizardIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            New Reel
          </span>
        </button>
      </div>

      {/* BASE -- blue family, lightest to darkest: Clip, Thumbnail, Cutaway, Text Slide */}
      <div className="relative flex h-full gap-3">
        <GroupLabel
          colorClassName="text-blue-600 dark:text-blue-400"
          help={{
            id: "tools-base",
            title: "Base: the story of your reel",
            body: (
              <>
                <p>These build the main video, one clip after another.</p>
                <ul className="list-disc pl-4">
                  <li>
                    <strong className="text-foreground">Clip</strong> &ndash; choose the frame shape (vertical for
                    Reels/Shorts, wide for YouTube)
                  </li>
                  <li>
                    <strong className="text-foreground">Thumbnail</strong> &ndash; pick the cover image
                  </li>
                  <li>
                    <strong className="text-foreground">Cutaway</strong> &ndash; add another video or an animated photo
                  </li>
                  <li>
                    <strong className="text-foreground">Text Slide</strong> &ndash; a full-screen title card
                  </li>
                </ul>
              </>
            ),
          }}
        >
          Base
        </GroupLabel>
        <button
          type="button"
          onClick={onOpenClipRectDialog}
          title="Clip rectangle"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-blue-500 dark:text-blue-300 hover:bg-background"
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
          onClick={onOpenCoverPicker}
          title="Thumbnail -- pick the frame shown before this reel plays"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-blue-600 dark:text-blue-400 hover:bg-background"
        >
          <CoverIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Thumbnail
          </span>
          {coverThumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- a permanent R2 URL swatch, not a Next-optimizable remote image worth configuring
            <img src={coverThumbnailUrl} alt="" className="mt-auto h-4 w-4 rounded object-cover" />
          )}
        </button>
        <button
          type="button"
          onClick={onOpenCutawayDialog}
          title="Add a Cutaway -- a video clip or an animated photo, appended to the reel"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-blue-700 dark:text-blue-500 hover:bg-background"
        >
          <ImageMotionIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Cutaway
          </span>
          <CountBadge count={cutawayCount} />
        </button>
        <button
          type="button"
          draggable
          onDragStart={(e) => {
            // Lets CutawayTrack's own rail accept a drop at a specific
            // position in the sequence (see its onDropNewTextSlide prop) --
            // the click path above still always appends to the end, this is
            // just an additional way in. A plain click still works fine
            // alongside `draggable` -- native drag-and-drop only kicks in
            // once the pointer actually moves past the browser's own drag
            // threshold, same as CutawayTrack's own DRAG_THRESHOLD_PX for
            // its internal reorder drag.
            e.dataTransfer.setData(NEW_CUTAWAY_DRAG_TYPE, "text");
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={onOpenTextSlideDialog}
          title="Add a Text Slide -- a full-frame slide of text and/or an image, with its own duration, that slides in and out of the reel. Drag onto the timeline to drop it at a specific spot."
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-blue-800 dark:text-blue-600 hover:bg-background cursor-grab active:cursor-grabbing"
        >
          <TextSlideIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Text Slide
          </span>
          <CountBadge count={textSlideCount} />
        </button>
      </div>

      {/* OVERLAYS -- amber family, lightest to darkest: Images & Videos, Props, Peeps, Label, TTS, Avatar */}
      <div className="relative flex h-full gap-3">
        <GroupLabel
          colorClassName="text-amber-600 dark:text-amber-400"
          help={{
            id: "tools-overlays",
            title: "Overlays: layer things on top",
            body: (
              <>
                <p>
                  Overlays sit on top of your main video for a stretch of time without changing its length &mdash; a
                  second video or photo, price/name labels, a voiceover, or an animated character.
                </p>
                <p>
                  After adding one, drag it on the timeline below to move it, or drag its edges to change how long it
                  shows.
                </p>
              </>
            ),
          }}
        >
          Overlays
        </GroupLabel>
        <button
          type="button"
          onClick={onOpenOverlayPicker}
          title="Images & Videos -- a photo or a video on its own switchable Full-Screen/Picture-in-Picture/Split Screen layer"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-amber-400 dark:text-amber-300 hover:bg-background"
        >
          <VideoOverlayIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Images & Videos
          </span>
          <CountBadge count={overlayCount} />
        </button>
        <button
          type="button"
          onClick={onOpenPropsDialog}
          title="Props -- ready-made see-through artwork (a car, a cup, a post box...) to drop into your scene, each on its own timeline row"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-amber-500 dark:text-amber-400 hover:bg-background"
        >
          <PropsIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Props
          </span>
        </button>
        <button
          type="button"
          onClick={onOpenPeepsDialog}
          title="Peeps -- build a hand-drawn character (hair, face, outfit, pose) and drop it into your scene; double-click it later to edit"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-amber-500 dark:text-amber-400 hover:bg-background"
        >
          <PeepsIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Peeps
          </span>
        </button>
        <button
          type="button"
          onClick={onOpenTextDialog}
          title="Add a label -- a pill, capsule or tag (e.g. a price and a name) with your own text, shown for as long as you choose"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-amber-600 dark:text-amber-500 hover:bg-background"
        >
          <LabelGlyphIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Label
          </span>
          <CountBadge count={textOverlayCount} />
        </button>
        <button
          type="button"
          onClick={onOpenTtsDialog}
          title="TTS Narration -- type a script, generate speech, and caption it as background text or word-by-word karaoke"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-amber-700 dark:text-amber-600 hover:bg-background"
        >
          <TtsIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            TTS
          </span>
          <CountBadge count={ttsOverlayCount} />
        </button>
        <button
          type="button"
          onClick={onOpenAvatarDialog}
          title="Avatar -- a 2D animated character (pick who, pick what they're doing) placed on the frame"
          className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pb-2 pt-2 text-amber-800 dark:text-amber-700 hover:bg-background"
        >
          <AvatarPersonIcon className="h-4 w-4" />
          <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
            Avatar
          </span>
          <CountBadge count={avatarOverlayCount} />
        </button>
      </div>
    </div>
  );
}
