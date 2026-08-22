"use client";

/**
 * Icons for the Arrange/Transform action buttons in UserActions.tsx. Same
 * plain-outline-SVG approach as icons/TemplateIcons.tsx -- one-off,
 * domain-specific glyphs, not worth pulling in an icon library for.
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

function DeleteIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </svg>
  );
}

function TrimIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <path d="M7.5 7.5 20 20M20 4 7.5 16.5" />
    </svg>
  );
}

function DragIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M4 12h16M4 12l4-4M4 12l4 4M20 12l-4-4M20 12l-4 4" />
    </svg>
  );
}

function ZoomInIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <circle cx="10" cy="10" r="7" />
      <path d="M21 21l-5.5-5.5M10 7v6M7 10h6" />
    </svg>
  );
}

function ZoomOutIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <circle cx="10" cy="10" r="7" />
      <path d="M21 21l-5.5-5.5M7 10h6" />
    </svg>
  );
}

function PanTiltIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <path d="M12 3v3.5M12 3l-2 2.3M12 3l2 2.3" />
      <path d="M12 21v-3.5M12 21l-2-2.3M12 21l2-2.3" />
      <path d="M3 12h3.5M3 12l2.3-2M3 12l2.3 2" />
      <path d="M21 12h-3.5M21 12l-2.3-2M21 12l-2.3 2" />
    </svg>
  );
}

function FlipIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M12 3v18" strokeDasharray="2 2" />
      <path d="M9 8 5 12l4 4Z" fill="currentColor" stroke="none" />
      <path d="M15 8l4 4-4 4Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function MirrorIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M3 12h18" strokeDasharray="2 2" />
      <path d="M8 9 12 5l4 4Z" fill="currentColor" stroke="none" />
      <path d="M8 15l4 4 4-4Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export const ACTION_ICONS: Record<string, (props: IconProps) => React.JSX.Element> = {
  delete: DeleteIcon,
  trim: TrimIcon,
  drag: DragIcon,
  "zoom-in": ZoomInIcon,
  "zoom-out": ZoomOutIcon,
  "pan-tilt": PanTiltIcon,
  flip: FlipIcon,
  mirror: MirrorIcon,
};
