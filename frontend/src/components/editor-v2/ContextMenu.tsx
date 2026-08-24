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
import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
  // Starts at the raw click point (state.x/y); clamped to stay fully inside
  // the viewport once the menu's actual rendered size is known below --
  // otherwise a right-click near the right/bottom edge (e.g. the last
  // segment on a timeline that runs to the edge of the screen) opens a menu
  // that spills off-screen and becomes unclickable.
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Runs synchronously before paint, so the unclamped position (used only
  // for this one render pass) is never actually shown to the user.
  useLayoutEffect(() => {
    if (!state) return;
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 4;
    const left = Math.max(margin, Math.min(state.x, window.innerWidth - menu.offsetWidth - margin));
    const top = Math.max(margin, Math.min(state.y, window.innerHeight - menu.offsetHeight - margin));
    setPosition({ left, top });
  }, [state]);

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

  const { top, left } = position ?? { top: state.y, left: state.x };

  return (
    <div
      ref={menuRef}
      style={{ position: "fixed", top, left, zIndex: 60 }}
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
