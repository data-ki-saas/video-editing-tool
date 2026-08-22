"use client";

/**
 * Three side-by-side sections (spread horizontally, not stacked, per
 * feedback -- there's no separate heading either, the content is
 * self-explanatory):
 *  1. Template style picker
 *  2. Clip-rectangle aspect-ratio picker (drives the crop overlay on the
 *     play area/timeline -- the only frame-affecting choice here, along
 *     with Zoom In/Out below, so only their changes land in the change
 *     history -- see ThreePaneEditor)
 *  3. Action buttons, grouped Arrange (Delete/Trim/Drag, still disabled
 *     scaffolding -- each needs its own real interaction design for region
 *     selection/drag-to-timeline) and Transform. Crop, Zoom In/Out, Pan &
 *     Tilt, Flip, and Mirror are all just manipulations of the ONE clip
 *     rectangle now, not separate buttons -- Crop is automatic (picking a
 *     ratio places it), Zoom In/Out create a transition from here (a
 *     default scale toward/away from center), and Flip/Mirror/Pan/Tilt all
 *     happen by dragging/resizing/toggling directly on the rectangle
 *     itself (see CropRectOverlay.tsx's edge handles and
 *     ThreePaneEditor's handleCropRectCommit). That's why there's no
 *     separate Flip/Mirror/Pan/Tilt button here.
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

function ActionButton({
  id,
  label,
  disabled,
  onClick,
}: {
  id: string;
  label: string;
  disabled: boolean;
  onClick?: () => void;
}) {
  const Icon = ACTION_ICONS[id];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={disabled ? "Coming soon" : label}
      className={
        "flex w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-transparent p-1 " +
        (disabled ? "opacity-40" : "hover:bg-background")
      }
    >
      <Icon className="h-5 w-5 text-foreground" />
      <span className="w-full truncate text-center text-[10px] text-muted">{label}</span>
    </button>
  );
}

function ActionButtonsSection({
  canZoom,
  onZoomIn,
  onZoomOut,
}: {
  canZoom: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  return (
    <div className="flex h-full flex-1 flex-col gap-2 overflow-y-auto">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Arrange</span>
        <div className="flex gap-2 overflow-x-auto">
          {ARRANGE_ACTIONS.map((action) => (
            <ActionButton key={action.id} id={action.id} label={action.label} disabled />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Transform</span>
        <p className="text-[10px] text-accent">
          Crop, Pan/Tilt, and Flip/Mirror all happen on the clip rectangle itself (drag, resize, or use its edge
          handles)
        </p>
        <div className="flex gap-2 overflow-x-auto">
          <ActionButton id="zoom-in" label="Zoom In" disabled={!canZoom} onClick={onZoomIn} />
          <ActionButton id="zoom-out" label="Zoom Out" disabled={!canZoom} onClick={onZoomOut} />
        </div>
        {!canZoom && <p className="text-[10px] text-muted">Pick a clip rectangle first to enable Zoom In/Out.</p>}
      </div>
    </div>
  );
}

export function UserActions({
  selectedTemplateId,
  onSelectTemplate,
  selectedClipRectId,
  onSelectClipRect,
  canZoom,
  onZoomIn,
  onZoomOut,
}: {
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string) => void;
  selectedClipRectId: string | null;
  onSelectClipRect: (id: string) => void;
  canZoom: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  return (
    <div className="flex h-full gap-3 overflow-x-auto">
      <CollapsiblePanel label="Template" icon={<TemplateGridIcon className="h-4 w-4" />} expandedClassName="w-40">
        <TemplateSection selectedTemplateId={selectedTemplateId} onSelectTemplate={onSelectTemplate} />
      </CollapsiblePanel>
      <CollapsiblePanel label="Clip rectangle" icon={<CropToolIcon className="h-4 w-4" />} expandedClassName="w-28">
        <ClipRectSection selectedClipRectId={selectedClipRectId} onSelectClipRect={onSelectClipRect} />
      </CollapsiblePanel>
      <ActionButtonsSection canZoom={canZoom} onZoomIn={onZoomIn} onZoomOut={onZoomOut} />
    </div>
  );
}
