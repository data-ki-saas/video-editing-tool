"use client";

/**
 * A panel that collapses to a narrow strip showing just an icon and a
 * vertically-set label, expanding to its full content on click -- used for
 * the Background track / Template / Clip rectangle panels, none of which
 * need to stay open at once and together would otherwise eat a lot of the
 * Action Area's width.
 */
import { useState } from "react";
import type { ReactNode } from "react";

export function CollapsiblePanel({
  label,
  icon,
  expandedClassName = "w-40",
  children,
}: {
  label: string;
  icon: ReactNode;
  expandedClassName?: string;
  children: ReactNode;
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  if (isCollapsed) {
    return (
      <button
        type="button"
        onClick={() => setIsCollapsed(false)}
        title={`Expand ${label}`}
        className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-r border-border pt-2 text-muted hover:bg-background"
      >
        {icon}
        <span className="text-[10px] tracking-wide" style={{ writingMode: "vertical-rl" }}>
          {label}
        </span>
      </button>
    );
  }

  return (
    <div className={`flex h-full shrink-0 flex-col gap-1 overflow-hidden border-r border-border pr-4 ${expandedClassName}`}>
      <button
        type="button"
        onClick={() => setIsCollapsed(true)}
        title={`Collapse ${label}`}
        className="flex shrink-0 items-center gap-1 text-xs text-muted hover:text-foreground"
      >
        {icon}
        <span>{label}</span>
      </button>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
