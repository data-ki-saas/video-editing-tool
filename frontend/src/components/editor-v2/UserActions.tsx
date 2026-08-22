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
 * There is no separate "Transform" menu (Zoom In/Out, Pan & Tilt, Flip,
 * Mirror) -- the clip rectangle is the clip's fixed property, and every
 * transform is a manipulation of it directly: Crop is automatic (picking
 * a ratio places it), Zoom/Pan happen by dragging/resizing it at a
 * different point on the timeline (see ThreePaneEditor's
 * handleCropRectCommit -- the resulting transition only ever applies
 * within its own range on ZoomEffectRow below the frames, not past it),
 * and Flip/Mirror toggle from CropRectOverlay's own edge handles. Arrange
 * (Delete/Trim/Drag) is still disabled scaffolding -- each needs its own
 * real interaction design for region selection/drag-to-timeline.
 */
import { TEMPLATE_OPTIONS } from "@/lib/templates";
import { TEMPLATE_ICONS } from "./icons/TemplateIcons";
import { ACTION_ICONS } from "./icons/ActionIcons";
import { TemplateGridIcon, CropToolIcon } from "@/components/icons/UIIcons";
import { CLIP_RECT_OPTIONS, ClipRectIcon } from "./ClipRectIcon";
import { CollapsiblePanel } from "./CollapsiblePanel";

const ARRANGE_ACTIONS = [
  { id: "delete", label: "Delete" },
  { id: "trim", label: "Trim" },
  { id: "drag", label: "Drag" },
];

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

function ActionButton({ id, label }: { id: string; label: string }) {
  const Icon = ACTION_ICONS[id];
  return (
    <button
      type="button"
      disabled
      title="Coming soon"
      className="flex w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-transparent p-1 opacity-40"
    >
      <Icon className="h-5 w-5 text-foreground" />
      <span className="w-full truncate text-center text-[10px] text-muted">{label}</span>
    </button>
  );
}

function ArrangeSection() {
  return (
    <div className="flex h-full flex-1 flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Arrange</span>
      <p className="text-[10px] text-accent">
        Crop, Zoom/Pan, and Flip/Mirror all happen on the clip rectangle itself, not from a menu -- drag or resize
        it, or use its edge handles
      </p>
      <div className="flex gap-2 overflow-x-auto">
        {ARRANGE_ACTIONS.map((action) => (
          <ActionButton key={action.id} id={action.id} label={action.label} />
        ))}
      </div>
    </div>
  );
}

export function UserActions({
  selectedTemplateId,
  onSelectTemplate,
  selectedClipRectId,
  onSelectClipRect,
}: {
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string) => void;
  selectedClipRectId: string | null;
  onSelectClipRect: (id: string) => void;
}) {
  return (
    <div className="flex h-full gap-3 overflow-x-auto">
      <CollapsiblePanel label="Template" icon={<TemplateGridIcon className="h-4 w-4" />} expandedClassName="w-40">
        <TemplateSection selectedTemplateId={selectedTemplateId} onSelectTemplate={onSelectTemplate} />
      </CollapsiblePanel>
      <CollapsiblePanel label="Clip rectangle" icon={<CropToolIcon className="h-4 w-4" />} expandedClassName="w-28">
        <ClipRectSection selectedClipRectId={selectedClipRectId} onSelectClipRect={onSelectClipRect} />
      </CollapsiblePanel>
      <ArrangeSection />
    </div>
  );
}
