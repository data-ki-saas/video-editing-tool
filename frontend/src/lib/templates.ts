/**
 * The catalogue of editing "template" styles a user can apply to a reel.
 * Selection-only for now (see components/editor-v2/UserActions.tsx) -- this
 * is data, not behavior: nothing here actually edits the timeline yet.
 */
export interface TemplateOption {
  id: string;
  name: string;
  description: string;
  useCases: string;
}

export const TEMPLATE_OPTIONS: TemplateOption[] = [
  {
    id: "beat-sync",
    name: "Beat Sync",
    description:
      "Templates that automatically sync your clips to the beat of a song. Often uses fast cuts, zooms, and visual effects timed to the music's drops.",
    useCases: 'High-energy content like fashion transitions, dance videos, product reveals, and "glow-up" montages.',
  },
  {
    id: "transformation",
    name: "Transformation",
    description: "Uses a split-screen or a smooth swipe transition to show a dramatic change.",
    useCases: "Fitness transformations, home renovations, make-up tutorials, and product demos.",
  },
  {
    id: "photo-collab",
    name: "Photo Collab",
    description:
      "Pairs multiple photos or video clips in a sequence with smooth transitions and text overlays. Often used for storytelling or creating a collage of moments.",
    useCases: "Travel compilations, event recaps (birthdays, weddings), brand collaborations, and memory dumps.",
  },
  {
    id: "product-showcase",
    name: "Product Showcase",
    description: "Features smooth transitions, zoom-ins, and beat-synced reveals to highlight a product's features.",
    useCases: "Unboxing videos, feature highlights, and e-commerce ads for physical products.",
  },
  {
    id: "tutorial",
    name: "Tutorial",
    description: "Provides a clear, step-by-step structure with text overlays and simple transitions.",
    useCases: "Educational content, cooking recipes, DIY projects, and tech tips.",
  },
  {
    id: "narrative",
    name: "Narrative",
    description: "A softer, more cinematic style with slower pacing, longer clips, and fewer transitions.",
    useCases: 'Emotional storytelling, aesthetic montages, self-care content, and "day in the life" vlogs.',
  },
  {
    id: "testimonial",
    name: "Testimonial",
    description: "Focuses on a person speaking to the camera, often with text highlights and a clean, simple layout.",
    useCases: "Customer reviews, influencer endorsements, and reactive content to news or trends.",
  },
  {
    id: "attitude",
    name: "Attitude",
    description: "Features fast-paced cuts, glitch effects, and bold text to create a confident and trendy vibe.",
    useCases: "Fashion, streetwear, gym content, and personal branding for a younger audience.",
  },
  {
    id: "lyrics",
    name: "Lyrics",
    description: "Centers on displaying song lyrics or inspirational quotes with moving text and background visuals.",
    useCases: "Music promotion, motivational posts, and aesthetic quote videos.",
  },
];
