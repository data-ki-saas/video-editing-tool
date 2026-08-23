"use client";

/**
 * Two side-by-side sections (spread horizontally, not stacked, per
 * feedback -- there's no separate heading either, the content is
 * self-explanatory):
 *  1. Template style picker
 *  2. Clip-rectangle aspect-ratio picker (drives the crop overlay on the
 *     play area/timeline -- the only frame-affecting choice here, so only
 *     its changes land in the change history -- see ThreePaneEditor)
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
 *
 * "Text" is a third trigger here, styled like the two collapsible panels'
 * own collapsed state but opening TextOverlayDialog (a modal, owned by
 * ActionArea) rather than expanding inline -- adding a caption needs a
 * template gallery and a text box, more than a narrow side panel can hold.
 */
import { TEMPLATE_OPTIONS } from "@/lib/templates";
import { TEMPLATE_ICONS } from "./icons/TemplateIcons";
import { TemplateGridIcon, CropToolIcon } from "@/components/icons/UIIcons";
import { CLIP_RECT_OPTIONS, ClipRectIcon } from "./ClipRectIcon";
import { CollapsiblePanel } from "./CollapsiblePanel";

function TextGlyphIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className}>
      <path d="M5 6h14M12 6v13" />
    </svg>
  );
}

function TemplateSection({
  selectedTemplateId,
  onSelectTemplate,
}: {
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string) => void;
}) {
  return (
    <div className="grid h-full grid-cols-3 gap-1 overflow-y-auto">
      {TEMPLATE_OPTIONS.map((template) => {
        const Icon = TEMPLATE_ICONS[template.id];
        const isSelected = template.id === selectedTemplateId;
        return (
          <button
            key={template.id}
            type="button"
            title={`${template.name} -- ${template.useCases}`}
            onClick={() => onSelectTemplate(template.id)}
            className={
              "flex flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 " +
              (isSelected ? "border-accent bg-accent/10" : "border-transparent hover:bg-background")
            }
          >
            <Icon className="h-5 w-5 shrink-0 text-foreground" />
            <span className="w-full truncate text-center text-[10px] text-muted">{template.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function ClipRectSection({
  selectedClipRectId,
  onSelectClipRect,
}: {
  selectedClipRectId: string | null;
  onSelectClipRect: (id: string) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto">
      {CLIP_RECT_OPTIONS.map((option) => {
        const isSelected = option.id === selectedClipRectId;
        return (
          <button
            key={option.id}
            type="button"
            title={option.name}
            onClick={() => onSelectClipRect(option.id)}
            className={
              "flex items-center gap-1.5 rounded-md border-2 px-1 py-0.5 text-foreground " +
              (isSelected ? "border-accent bg-accent/10" : "border-transparent hover:bg-background")
            }
          >
            <ClipRectIcon option={option} />
            <span className="text-[10px] text-muted">{option.ratioLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

export function UserActions({
  selectedTemplateId,
  onSelectTemplate,
  selectedClipRectId,
  onSelectClipRect,
  onOpenTextDialog,
}: {
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string) => void;
  selectedClipRectId: string | null;
  onSelectClipRect: (id: string) => void;
  onOpenTextDialog: () => void;
}) {
  return (
    <div className="flex h-full gap-3 overflow-x-auto">
      <CollapsiblePanel label="Template" icon={<TemplateGridIcon className="h-4 w-4" />} expandedClassName="w-40">
        <TemplateSection selectedTemplateId={selectedTemplateId} onSelectTemplate={onSelectTemplate} />
      </CollapsiblePanel>
      <CollapsiblePanel label="Clip rectangle" icon={<CropToolIcon className="h-4 w-4" />} expandedClassName="w-28">
        <ClipRectSection selectedClipRectId={selectedClipRectId} onSelectClipRect={onSelectClipRect} />
      </CollapsiblePanel>
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
    </div>
  );
}
