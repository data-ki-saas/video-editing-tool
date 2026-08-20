"use client";

import { createContext, useContext, useMemo, useState } from "react";

export type PanelKind = "assets" | "upload" | "trim" | "background" | "overlay" | "render";

export interface EditorAction {
  key: PanelKind;
  label: string;
  disabled: boolean;
  // Shows a spinner next to the action in the sidebar -- for the two
  // genuinely time-consuming operations (upload, render), so progress stays
  // visible even if the user switches to a different panel meanwhile.
  busy?: boolean;
}

export interface EditorCapabilities {
  actions: EditorAction[];
}

interface EditorPanelContextValue {
  activePanel: PanelKind;
  setActivePanel: (panel: PanelKind) => void;
  // Published by the active reel editor (VideoEditor) so the sidebar -- a
  // layout-level sibling, not a descendant -- knows which action buttons to
  // show and whether each is enabled. null outside a project editor.
  capabilities: EditorCapabilities | null;
  setCapabilities: (capabilities: EditorCapabilities | null) => void;
  // Lets the sidebar's sign-out flush VideoEditor's debounced autosave
  // before it clears the session -- otherwise a sign-out mid-debounce can
  // drop (or silently no-op) the last edit. null outside a project editor.
  flushPendingSave: (() => Promise<void>) | null;
  setFlushPendingSave: (flush: (() => Promise<void>) | null) => void;
}

const EditorPanelContext = createContext<EditorPanelContextValue | null>(null);

export function EditorPanelProvider({ children }: { children: React.ReactNode }) {
  const [activePanel, setActivePanel] = useState<PanelKind>("assets");
  const [capabilities, setCapabilities] = useState<EditorCapabilities | null>(null);
  const [flushPendingSave, setFlushPendingSave] = useState<(() => Promise<void>) | null>(null);

  const value = useMemo(
    () => ({ activePanel, setActivePanel, capabilities, setCapabilities, flushPendingSave, setFlushPendingSave }),
    [activePanel, capabilities, flushPendingSave]
  );

  return <EditorPanelContext.Provider value={value}>{children}</EditorPanelContext.Provider>;
}

export function useEditorPanel() {
  const ctx = useContext(EditorPanelContext);
  if (!ctx) throw new Error("useEditorPanel must be used within EditorPanelProvider");
  return ctx;
}
