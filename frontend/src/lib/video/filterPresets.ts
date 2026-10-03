/**
 * The color-filter catalog for the base clip -- applies to every video AND
 * image segment alike. Each preset carries a standard CSS `filter` string
 * (`cssFilter`), applied via `ctx.filter` by both CanvasPlayer's live preview
 * and the local exporter, so the two can't drift apart.
 */
export type FilterPresetId = "none" | "bw" | "vivid" | "vintage" | "warm" | "cool" | "high-contrast";

export interface FilterPresetOption {
  id: FilterPresetId;
  name: string;
  /** CSS `filter` string for CanvasPlayer's live preview (ctx.filter). */
  cssFilter: string;
}

export const FILTER_PRESET_OPTIONS: FilterPresetOption[] = [
  { id: "none", name: "Original", cssFilter: "none" },
  { id: "bw", name: "Black & White", cssFilter: "grayscale(1)" },
  { id: "vivid", name: "Vivid", cssFilter: "saturate(1.6) contrast(1.15)" },
  { id: "vintage", name: "Vintage", cssFilter: "sepia(0.35) saturate(0.85) contrast(0.9) brightness(1.05)" },
  { id: "warm", name: "Warm", cssFilter: "sepia(0.15) saturate(1.25) brightness(1.06) hue-rotate(-6deg)" },
  { id: "cool", name: "Cool", cssFilter: "saturate(1.1) contrast(1.1) hue-rotate(10deg) brightness(0.97)" },
  { id: "high-contrast", name: "High Contrast", cssFilter: "contrast(1.4) saturate(1.1)" },
];

export function getFilterPresetOption(id: FilterPresetId | null): FilterPresetOption {
  return FILTER_PRESET_OPTIONS.find((option) => option.id === id) ?? FILTER_PRESET_OPTIONS[0];
}
