"use client";

/**
 * The aspect-ratio "clip rectangle" choices a user can pick for how their
 * reel gets cropped/framed, each rendered as an outline rectangle actually
 * drawn in that ratio (not a fixed-size placeholder) so the shape itself
 * communicates the ratio before the reader even looks at the label.
 */
export interface ClipRectOption {
  id: string;
  ratioLabel: string;
  name: string;
  widthRatio: number;
  heightRatio: number;
}

export const CLIP_RECT_OPTIONS: ClipRectOption[] = [
  { id: "16:9", ratioLabel: "16:9", name: "Widescreen Standard Video", widthRatio: 16, heightRatio: 9 },
  { id: "9:16", ratioLabel: "9:16", name: "Portrait / YouTube Shorts", widthRatio: 9, heightRatio: 16 },
  { id: "4:3", ratioLabel: "4:3", name: "Standard / Classic TV", widthRatio: 4, heightRatio: 3 },
  { id: "1:1", ratioLabel: "1:1", name: "Square", widthRatio: 1, heightRatio: 1 },
  { id: "21:9", ratioLabel: "21:9", name: "Cinematic / Ultrawide", widthRatio: 21, heightRatio: 9 },
  { id: "2.35:1", ratioLabel: "2.35:1", name: "CinemaScope", widthRatio: 2.35, heightRatio: 1 },
];

const BOX_SIZE_PX = 40;

/** Scales a ratio to fit inside a BOX_SIZE_PX square, preserving its shape
 * -- the longer side always touches the box edge, so a 21:9 rectangle reads
 * as a thin bar and a 1:1 one reads as a full square, at a glance. */
function fitToBox(widthRatio: number, heightRatio: number) {
  const scale = BOX_SIZE_PX / Math.max(widthRatio, heightRatio);
  return { width: widthRatio * scale, height: heightRatio * scale };
}

export function ClipRectIcon({ option }: { option: ClipRectOption }) {
  const { width, height } = fitToBox(option.widthRatio, option.heightRatio);
  return (
    <svg width={BOX_SIZE_PX} height={BOX_SIZE_PX} viewBox={`0 0 ${BOX_SIZE_PX} ${BOX_SIZE_PX}`} aria-hidden="true">
      <rect
        x={(BOX_SIZE_PX - width) / 2}
        y={(BOX_SIZE_PX - height) / 2}
        width={width}
        height={height}
        rx={1.5}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </svg>
  );
}
