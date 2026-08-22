"use client";

/**
 * One representative icon per template style in lib/templates.ts. Plain
 * outline SVGs (24x24, stroke=currentColor) rather than an icon-font/library
 * dependency -- there are only nine of these and each needs to be a
 * one-off, specific-to-this-domain glyph.
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

function BeatSyncIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </svg>
  );
}

function TransformationIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" strokeDasharray="2 2" />
      <path d="M9 12H6m0 0 2-2m-2 2 2 2M15 12h3m0 0-2-2m2 2-2 2" />
    </svg>
  );
}

function PhotoCollabIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <rect x="3" y="8" width="13" height="13" rx="2" />
      <rect x="8" y="3" width="13" height="13" rx="2" />
    </svg>
  );
}

function ProductShowcaseIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <rect x="4" y="10" width="16" height="10" rx="1" />
      <rect x="3" y="7" width="18" height="3.5" rx="1" />
      <path d="M12 7v13" />
      <path d="M9 7c0-2 1-3.5 3-3.5s3 1.5 3 3.5" />
    </svg>
  );
}

function TutorialIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <circle cx="8.5" cy="8" r="0.75" fill="currentColor" stroke="none" />
      <path d="M11 8h5.5" />
      <circle cx="8.5" cy="12" r="0.75" fill="currentColor" stroke="none" />
      <path d="M11 12h5.5" />
      <circle cx="8.5" cy="16" r="0.75" fill="currentColor" stroke="none" />
      <path d="M11 16h3.5" />
    </svg>
  );
}

function NarrativeIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M20 15.2A8.2 8.2 0 1 1 9.8 5a6.8 6.8 0 0 0 10.2 10.2Z" />
    </svg>
  );
}

function TestimonialIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 16v4l5-4" />
    </svg>
  );
}

function AttitudeIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M12 3c-1.3 2.7-4 4.3-4 7.8a4 4 0 0 0 8 0c0-.9-.4-1.6-.8-2.3.7.9 2.3 2.7 2.3 5a5.5 5.5 0 1 1-11 0c0-5 3.6-7 5.5-10.5Z" />
    </svg>
  );
}

function LyricsIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M8.5 7.5c-1.7 0-2.8 1.1-2.8 2.8S6.8 13 8.5 13" />
      <rect x="5.7" y="9.3" width="2" height="3" rx="0.6" />
      <path d="M16.5 7.5c-1.7 0-2.8 1.1-2.8 2.8s1.1 2.7 2.8 2.7" />
      <rect x="13.7" y="9.3" width="2" height="3" rx="0.6" />
    </svg>
  );
}

export const TEMPLATE_ICONS: Record<string, (props: IconProps) => React.JSX.Element> = {
  "beat-sync": BeatSyncIcon,
  transformation: TransformationIcon,
  "photo-collab": PhotoCollabIcon,
  "product-showcase": ProductShowcaseIcon,
  tutorial: TutorialIcon,
  narrative: NarrativeIcon,
  testimonial: TestimonialIcon,
  attitude: AttitudeIcon,
  lyrics: LyricsIcon,
};
