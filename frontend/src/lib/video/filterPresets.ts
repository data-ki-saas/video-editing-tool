/**
 * The color-filter catalog for the base clip -- applies to every video AND
 * image segment alike (see compileCreatomateTimeline.ts's buildMediaSegments,
 * which spreads getCreatomateFilterProperties' result onto both the `Video`
 * and `Image` constructors -- both extend the SDK's shared ElementBase, so
 * the same colorFilter/colorFilterValue/colorOverlay properties apply to
 * either element type unchanged, same as crop already does).
 *
 * Creatomate itself has no arbitrary filter-stack or LUT support -- only ONE
 * discrete `colorFilter` type per element (brighten | contrast | invert |
 * grayscale | sepia, see node_modules/creatomate/src/properties/
 * ColorFilterType.ts) plus an intensity (`colorFilterValue`) and an optional
 * tint (`colorOverlay`). Every preset below is a fixed combination of those
 * three primitives chosen to approximate a named creator-facing look, not a
 * literal implementation of it -- this is deliberately the ONLY place that
 * mapping lives (same "single source of truth" convention as
 * textTemplates.ts's per-template style), so CanvasPlayer's live preview and
 * the real Creatomate render can't drift apart from encoding the choice
 * twice. `cssFilter` is CanvasPlayer's own live-preview approximation (a
 * standard CSS `filter` string, applied via `ctx.filter`) of the exact same
 * combination -- not pixel-identical to Creatomate's own colorFilter
 * algorithm, but the closest same-primitives match available in a 2D canvas.
 */
export type FilterPresetId = "none" | "bw" | "vivid" | "vintage" | "warm" | "cool" | "high-contrast";

// Matches Creatomate's own ColorFilterType exactly (node_modules/creatomate/
// src/properties/ColorFilterType.ts) -- redeclared here rather than imported
// so this file (imported by the client-only CanvasPlayer/FilterPresetDialog)
// never pulls in the `creatomate` SDK package itself, same
// server-only-vs-client-safe split this file's own module comment and
// compileCreatomateTimeline.ts's module comment both call out.
type CreatomateColorFilterType = "brighten" | "contrast" | "invert" | "grayscale" | "sepia";

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

/** The real Creatomate-wire-format properties for a preset -- spread
 * directly onto a `new Video({...})` / `new Image({...})` call, same
 * pattern as buildCropProperties' return value. Empty object for "none" (or
 * null), so an unfiltered clip emits no colorFilter/colorOverlay keys at all
 * rather than a redundant explicit "off" value. */
export function getCreatomateFilterProperties(
  id: FilterPresetId | null
): { colorFilter?: CreatomateColorFilterType; colorFilterValue?: number; colorOverlay?: string } {
  switch (id) {
    case "bw":
      return { colorFilter: "grayscale", colorFilterValue: 100 };
    case "vivid":
      return { colorFilter: "contrast", colorFilterValue: 60 };
    case "vintage":
      return { colorFilter: "sepia", colorFilterValue: 45, colorOverlay: "rgba(220,190,150,0.12)" };
    case "warm":
      return { colorFilter: "brighten", colorFilterValue: 12, colorOverlay: "rgba(255,150,50,0.14)" };
    case "cool":
      return { colorFilter: "contrast", colorFilterValue: 20, colorOverlay: "rgba(60,130,200,0.14)" };
    case "high-contrast":
      return { colorFilter: "contrast", colorFilterValue: 85 };
    case "none":
    default:
      return {};
  }
}
