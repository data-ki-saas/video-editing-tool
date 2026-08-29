import type { Asset } from "@/lib/api";
import type { AppMetaEntry, TemplateElement, Timeline } from "@/lib/projects";

const REEL_WIDTH = 1080;
const REEL_HEIGHT = 1920;
const SECONDS_PER_CLIP = 4;
const MAX_TOTAL_SECONDS = 60;
const MAX_CLIPS = Math.floor(MAX_TOTAL_SECONDS / SECONDS_PER_CLIP);

/** Interpolates {key} placeholders in a niche's script_template (or any
 * other {key}-templated string, e.g. a wizard hook/CTA) with actual
 * attribute values. A placeholder with no matching attribute is dropped
 * entirely rather than left as a literal "{key}" -- e.g. "{make} {model}"
 * with only make set becomes "Honda", not "Honda {model}". */
export function interpolateScript(template: string, attributes: Record<string, string | number>): string {
  return template
    .replace(/\{(\w+)\}/g, (_match, key: string) => {
      const value = attributes[key];
      return value === undefined ? "" : String(value);
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Builds a valid, renderable Timeline deterministically from a project's
 * uploaded assets and its niche's script template -- no Preview SDK, no
 * manual editing. Backs the mobile quick-create flow (QuickCreate.tsx).
 *
 * Deliberate v1 simplifications, not a permanent design:
 * - Every clip gets the same flat SECONDS_PER_CLIP duration regardless of
 *   whether it's an image or a video -- probing a video's real duration
 *   client-side is extra complexity not worth it for a first pass.
 * - No pan/zoom keyframe animation: Creatomate's raw JSON keyframe wire
 *   format (as opposed to their JS SDK's typed Keyframe<T> builder, which
 *   this app doesn't use -- `source` is sent as a plain object) hasn't been
 *   verified here, and guessing it wrong would silently break every
 *   quick-create render. Each clip is a static fill instead; add animation
 *   once the exact format is confirmed against a real render.
 */
export function autoAssembleTimeline(
  assets: Asset[],
  options: { scriptTemplate?: string | null; attributes?: Record<string, string | number> } = {}
): Timeline {
  const clips = assets.slice(0, MAX_CLIPS);

  const elements: TemplateElement[] = clips.map((asset, index) => ({
    id: `clip-${asset.id}`,
    name: asset.filename,
    type: asset.kind === "video" ? "video" : "image",
    track: 1,
    time: index * SECONDS_PER_CLIP,
    duration: SECONDS_PER_CLIP,
    width: "100%",
    height: "100%",
    x: "50%",
    y: "50%",
    fit: "cover",
    source: null,
  }));

  const appMeta: Record<string, AppMetaEntry> = {};
  for (const asset of clips) {
    appMeta[`clip-${asset.id}`] = { role: "clip", assetId: asset.id };
  }

  const scriptTemplate = options.scriptTemplate;
  if (scriptTemplate) {
    const text = interpolateScript(scriptTemplate, options.attributes ?? {});
    if (text) {
      elements.push({
        id: "auto-caption",
        name: "Caption",
        type: "text",
        track: 2,
        time: 0,
        duration: clips.length * SECONDS_PER_CLIP,
        text,
        width: "90%",
        height: "20%",
        x: "50%",
        y: "85%",
        font_size: "6vh",
        fill_color: "#ffffff",
        background_color: "rgba(0,0,0,0.5)",
      });
      appMeta["auto-caption"] = { role: "text" };
    }
  }

  return {
    output_format: "mp4",
    width: REEL_WIDTH,
    height: REEL_HEIGHT,
    elements,
    _appMeta: appMeta,
  };
}
