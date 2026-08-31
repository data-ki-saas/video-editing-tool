/**
 * The "Canvas fill" catalog for a base clip whose own aspect ratio doesn't
 * match the project's canvas -- lets that clip show its full, uncropped
 * frame letterboxed/pillarboxed instead of the default crop-to-fill, with
 * the empty bars filled by a blurred full-bleed duplicate, a solid color, or
 * a gradient. "crop" is today's only behavior (destructive cover-crop, see
 * video_math.ts's computeMaxCoverageCropRect) and stays the default for
 * every clip that never touches this control -- absent/null reads as "crop"
 * everywhere via getCanvasFillMode, so no existing reel's render changes.
 *
 * Same server-safe/client-safe split as filterPresets.ts: this file never
 * imports the `creatomate` SDK package -- compileCreatomateTimeline.ts wires
 * these modes to real Blur/Shape SDK properties itself.
 */
export type CanvasFillMode = "crop" | "blur" | "solid" | "gradient";

export interface CanvasFillOption {
  id: CanvasFillMode;
  name: string;
}

// "Crop to Fill" listed LAST -- Blur is the recommended/first choice for a
// mismatched clip (what this feature is for); "Crop to Fill" is just today's
// existing behavior, already in effect without opening this dialog at all.
export const CANVAS_FILL_OPTIONS: CanvasFillOption[] = [
  { id: "blur", name: "Blur" },
  { id: "solid", name: "Solid Color" },
  { id: "gradient", name: "Gradient" },
  { id: "crop", name: "Crop to Fill" },
];

export function getCanvasFillOption(id: CanvasFillMode): CanvasFillOption {
  return CANVAS_FILL_OPTIONS.find((option) => option.id === id) ?? CANVAS_FILL_OPTIONS[CANVAS_FILL_OPTIONS.length - 1];
}

export const DEFAULT_CANVAS_FILL_COLOR = "#000000";
export const DEFAULT_CANVAS_FILL_GRADIENT_COLOR = "#4b5563";

// Fraction of the canvas's long edge -- resolution-independent, same
// fractions-of-frame convention as CropRect, rather than a fixed pixel
// count that would look different at a different render resolution.
export const CANVAS_FILL_BLUR_RADIUS_FRACTION = 0.05;

export function getCanvasFillMode(mode: CanvasFillMode | null | undefined): CanvasFillMode {
  return mode ?? "crop";
}
