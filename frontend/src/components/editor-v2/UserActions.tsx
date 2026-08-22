"use client";

/**
 * "User actions": three stacked sections --
 *  1. Template style picker
 *  2. Clip-rectangle aspect-ratio picker (drives ClipRectOverlay on the
 *     play area, and is the only one of these three that's frame-affecting
 *     -- see ThreePaneEditor for why only its changes land in the change
 *     history)
 *  3. Action buttons, grouped Arrange (Delete/Trim/Drag) and Transform
 *     (Crop/Zoom/Pan & Tilt/Flip/Mirror) -- all still disabled scaffolding;
 *     Crop is called out as automatic (driven by the clip-rectangle above)
 *     rather than a button, since there's no separate action to take for it.
 */
import { TEMPLATE_OPTIONS } from "@/lib/templates";
import { TEMPLATE_ICONS } from "./icons/TemplateIcons";
import { ACTION_ICONS } from "./icons/ActionIcons";
import { CLIP_RECT_OPTIONS, ClipRectIcon } from "./ClipRectIcon";

const ARRANGE_ACTIONS = [
  { id: "delete", label: "Delete" },
  { id: "trim", label: "Trim" },
  { id: "drag", label: "Drag" },
];

const TRANSFORM_ACTIONS = [
  { id: "zoom-in", label: "Zoom In" },
  { id: "zoom-out", label: "Zoom Out" },
  { id: "pan-tilt", label: "Pan & Tilt" },
  { id: "flip", label: "Flip" },
  { id: "mirror", label: "Mirror" },
];

function TemplateRow({
  selectedTemplateId,
  onSelectTemplate,
}: {
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string) => void;
}) {
  return (
    <div className="flex h-24 shrink-0 flex-col gap-1">
      <span className="text-xs text-muted">Template</span>
      <div className="flex flex-1 gap-2 overflow-x-auto">
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
                "flex h-full w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1 " +
                (isSelected ? "border-accent bg-accent/10" : "border-transparent hover:bg-background")
              }
            >
              <Icon className="h-5 w-5 shrink-0 text-foreground" />
              <span className="w-full truncate text-center text-[10px] text-muted">{template.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ClipRectRow({
  selectedClipRectId,
  onSelectClipRect,
}: {
  selectedClipRectId: string | null;
  onSelectClipRect: (id: string) => void;
}) {
  return (
    <div className="flex h-20 shrink-0 flex-col gap-1">
      <span className="text-xs text-muted">Clip rectangle</span>
      <div className="flex flex-1 items-center gap-2 overflow-x-auto">
        {CLIP_RECT_OPTIONS.map((option) => {
          const isSelected = option.id === selectedClipRectId;
          return (
            <button
              key={option.id}
              type="button"
              title={option.name}
              onClick={() => onSelectClipRect(option.id)}
              className={
                "flex shrink-0 flex-col items-center gap-0.5 rounded-md border-2 p-1 text-foreground " +
                (isSelected ? "border-accent bg-accent/10" : "border-transparent hover:bg-background")
              }
            >
              <ClipRectIcon option={option} />
              <span className="text-[10px] text-muted">{option.ratioLabel}</span>
            </button>
          );
        })}
      </div>
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

function ActionButtonsSection() {
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <span className="text-xs text-muted">Action buttons</span>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Arrange</span>
        <div className="flex gap-2 overflow-x-auto">
          {ARRANGE_ACTIONS.map((action) => (
            <ActionButton key={action.id} id={action.id} label={action.label} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Transform</span>
        <p className="text-[10px] text-accent">Crop -- applied automatically from the clip rectangle above</p>
        <div className="flex gap-2 overflow-x-auto">
          {TRANSFORM_ACTIONS.map((action) => (
            <ActionButton key={action.id} id={action.id} label={action.label} />
          ))}
        </div>
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
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <h2 className="shrink-0 text-sm font-medium text-foreground">User actions</h2>
      <TemplateRow selectedTemplateId={selectedTemplateId} onSelectTemplate={onSelectTemplate} />
      <ClipRectRow selectedClipRectId={selectedClipRectId} onSelectClipRect={onSelectClipRect} />
      <ActionButtonsSection />
    </div>
  );
}
