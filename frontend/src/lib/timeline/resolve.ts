import type { Asset } from "@/lib/api";
import type { Timeline } from "@/lib/projects";

const REEL_WIDTH = 1080;
const REEL_HEIGHT = 1920;

export function createEmptyReelTimeline(): Timeline {
  return {
    output_format: "mp4",
    width: REEL_WIDTH,
    height: REEL_HEIGHT,
    elements: [
      {
        id: "main-video",
        name: "Main Video",
        type: "video",
        track: 1,
        time: 0,
        width: "100%",
        height: "100%",
        x: "50%",
        y: "50%",
        fit: "cover",
        source: null,
      },
    ],
    _appMeta: { "main-video": { role: "clip" } },
  };
}

/** A stored/persisted timeline never contains a real playable URL -- only
 * `_appMeta[id].assetId` references (see supabase/migrations 0004 and the
 * plan's data-model note: assets are private, presigned URLs expire, so one
 * saved into `elements[].source` would be dead by the next time the reel is
 * opened or rendered). This compiles a *display copy* with each referenced
 * element's `source` filled in from the caller's current, fresh asset list
 * -- for feeding straight to Preview.setSource(). Never persist the result;
 * always persist the timeline this was built from instead. */
export function resolveTimelineSources(timeline: Timeline, assets: Asset[]): Timeline {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  return {
    ...timeline,
    elements: timeline.elements.map((el) => {
      const assetId = timeline._appMeta[el.id]?.assetId;
      if (!assetId) return el;
      const asset = assetsById.get(assetId);
      return asset ? { ...el, source: asset.url } : el;
    }),
  };
}
