"use client";

/**
 * "User actions": pick a template style and a clip aspect ratio to apply to
 * the current reel. Sits between the asset gallery and the play area.
 * Selection-only for now (baby step) -- wiring these choices into the
 * actual timeline/render instructions is a later step.
 */
import { TEMPLATE_OPTIONS } from "@/lib/templates";
import { TEMPLATE_ICONS } from "./icons/TemplateIcons";
import { CLIP_RECT_OPTIONS, ClipRectIcon } from "./ClipRectIcon";

function TemplateRow({
  selectedTemplateId,
  onSelectTemplate,
}: {
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
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
    <div className="flex min-h-0 flex-1 flex-col gap-1">
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
    <div className="flex h-full flex-col gap-2">
      <h2 className="shrink-0 text-sm font-medium text-foreground">User actions</h2>
      <TemplateRow selectedTemplateId={selectedTemplateId} onSelectTemplate={onSelectTemplate} />
      <ClipRectRow selectedClipRectId={selectedClipRectId} onSelectClipRect={onSelectClipRect} />
    </div>
  );
}
