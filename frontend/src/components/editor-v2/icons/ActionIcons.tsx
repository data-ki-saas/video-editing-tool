"use client";

/**
 * Icons for CropRectOverlay's flip/mirror edge handles. Same plain-outline-
 * SVG approach as icons/TemplateIcons.tsx -- one-off, domain-specific
 * glyphs, not worth pulling in an icon library for.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const BASE_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function FlipIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M12 3v18" strokeDasharray="2 2" />
      <path d="M9 8 5 12l4 4Z" fill="currentColor" stroke="none" />
      <path d="M15 8l4 4-4 4Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function MirrorIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M3 12h18" strokeDasharray="2 2" />
      <path d="M8 9 12 5l4 4Z" fill="currentColor" stroke="none" />
      <path d="M8 15l4 4 4-4Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
