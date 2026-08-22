"use client";

/**
 * A minimal right-click context menu -- generic over a list of labeled
 * actions rather than hardcoding "delete", so ProjectList and AssetGallery
 * (its two current callers) can each supply their own action set, and any
 * future action beyond delete just adds another entry.
 *
 * Usage: `const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu()`
 * in the owning list, `onContextMenu={(e) => openContextMenu(e, [...])}` on
 * each item, and one `<ContextMenu state={contextMenuState} onClose={closeContextMenu} />`
 * rendered once per list.
 */
import { useEffect, useRef, useState } from "react";

export interface ContextMenuAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  actions: ContextMenuAction[];
}

export function useContextMenu() {
  const [contextMenuState, setContextMenuState] = useState<ContextMenuState | null>(null);

  function openContextMenu(e: React.MouseEvent, actions: ContextMenuAction[]) {
    e.preventDefault();
    setContextMenuState({ x: e.clientX, y: e.clientY, actions });
  }

  function closeContextMenu() {
    setContextMenuState(null);
  }

  return { contextMenuState, openContextMenu, closeContextMenu };
}

export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Closes on a click anywhere outside the menu, or on Escape -- there's no
  // other trigger to close it (it isn't tied to any particular element's
  // blur/focus), so this has to listen on the window directly.
  useEffect(() => {
    if (!state) return;

    function handlePointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [state, onClose]);

  if (!state) return null;

  return (
    <div
      ref={menuRef}
      style={{ position: "fixed", top: state.y, left: state.x, zIndex: 60 }}
      className="min-w-32 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-lg"
    >
      {state.actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => {
            action.onSelect();
            onClose();
          }}
          className={
            "block w-full px-3 py-1.5 text-left text-sm hover:bg-background " +
            (action.danger ? "text-red-600" : "text-foreground")
          }
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
