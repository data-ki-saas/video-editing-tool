/**
 * SERVER-ONLY. Turns the editor's live edit state into Creatomate's actual
 * render JSON (`Timeline.elements`/`_appMeta`) -- the piece editor-v2 never
 * had (see ThreePaneEditor.tsx's own module comment). Only ever imported
 * from `app/api/render/route.ts` (Node runtime): the `creatomate` package
 * is an "Official Node.js SDK" whose `Client.ts` pulls in `axios` and
 * Node's `perf_hooks`, neither of which exist in a browser bundle -- this
 * file must never be imported from a "use client" component, or the
 * editor's client bundle fails to build. The client only ever gathers
 * plain data (see gatherRenderClips.ts) and sends it to /api/render, which
 * calls compileCreatomateTimeline() itself before resolving asset URLs and
 * calling Creatomate.
 *
 * Building elements via the SDK's real classes (Video/Audio/Text/
 * Composition/Keyframe/animation classes) and calling .toMap() on each,
 * rather than hand-rolling snake_case JSON, is deliberate: Client.
 * startRender() sends a plain object VERBATIM (no key transformation) --
 * only an actual SDK class instance gets its camelCase properties
 * converted to Creatomate's real wire format. Guessing the wire format by
 * hand is exactly what the old lib/timeline/autoAssembleTimeline.ts's own
 * comment says blocked animation support there originally.
 *
 * Every mapping below was verified against the actual installed SDK
 * source (frontend/node_modules/creatomate/src/), not guessed. One
 * load-bearing assumption remains genuinely unverified: whether a numeric
 * Keyframe.time on a property of an element nested inside a Composition is
 * relative to that element's own start, or absolute against the root
 * timeline. Every place that matters is marked "SEGMENT-LOCAL TIME" below
 * -- if a real test render (see the plan's Verification section) shows
 * this assumption is wrong, every one of those call sites needs the same
 * one-line fix (add the segment's own outputStartSeconds).
 */
import {
  Video,
  Audio,
  Text,
  Image,
  Composition,
  Rectangle,
  Keyframe,
  TextTypewriter,
  TextAppearWordByWord,
  Fade,
  SlideLeft,
  WipeLeft,
} from "creatomate";
import type { EditSelectionsSnapshot, Timeline, TemplateElement, AppMetaEntry } from "@/lib/projects";
import {
  buildRenderSegments,
  mapSourceRangeToOutputRanges,
  totalSequenceDuration,
  totalRenderOutputDuration,
  computeEffectiveCropRect,
  reprojectCropRect,
  computeFlipSegments,
  computeOverlayRects,
  FULL_FRAME_CROP_RECT,
  type SequenceClipInfo,
  type CropRect,
  type ZoomEffect,
  type RenderSegment,
  type TranscriptCaption,
  type VideoOverlayClip,
} from "@/lib/video/video_math";
import { getTextTemplateFontFraction } from "@/lib/video/textTemplates";
import { getTranscriptCaptionConfig } from "@/lib/video/transcriptCaptionTemplates";
import { getCreatomateFilterProperties, type FilterPresetId } from "@/lib/video/filterPresets";
import type { CutTransitionId } from "@/lib/video/cutTransitionPresets";
import {
  getCanvasFillMode,
  CANVAS_FILL_BLUR_RADIUS_FRACTION,
  DEFAULT_CANVAS_FILL_COLOR,
  DEFAULT_CANVAS_FILL_GRADIENT_COLOR,
  type CanvasFillMode,
} from "@/lib/video/canvasFillPresets";

export interface CompileTimelineInput {
  selections: EditSelectionsSnapshot;
  /** Real per-clip durations for every clip in selections.sequenceClips,
   * in order -- gathered fresh client-side right before rendering (see
   * gatherRenderClips.ts), not reused from the preview pipeline. A video
   * entry's duration is probed from the file; an image entry's is its own
   * authored durationSeconds, carried straight through. */
  sequenceClips: SequenceClipInfo[];
  /** Same shape, for the resolved background-music sequence (empty if none). */
  backgroundClips: SequenceClipInfo[];
  /** Each video overlay source asset's own real probed duration, by
   * assetId -- gathered fresh client-side the same way sequenceClips'
   * durations are (ThreePaneEditor already caches this for
   * VideoOverlayTrack's edge-drag clamp; reused here). Needed so a video
   * overlay stretched past one play-through of its source (see
   * VideoOverlayTrack.tsx's edge-drag) renders as a real Creatomate loop
   * instead of trying to trim more of the source than exists. An overlay
   * whose assetId is missing here falls back to the old single-play
   * behavior (safe, just won't loop). */
  videoOverlaySourceDurations?: Record<string, number>;
  // Flat 0..1 multipliers, same values CanvasPlayer's live preview mixes
  // with (Timeline.mainAudioVolume/backgroundVolume) -- converted to
  // Creatomate's percent-string volume format below. No ducking here: the
  // "KNOWN LIMITATION" comment on buildVideoOverlayElements below already
  // covers why an overlay's own audio balance was never reproduced
  // server-side; this is an orthogonal flat level, unaffected by that gap.
  mainAudioVolume: number;
  backgroundVolume: number;
  outputWidth: number;
  outputHeight: number;
}

function toVolumePercent(level: number): string {
  return `${Math.round(Math.min(Math.max(level, 0), 1) * 100)}%`;
}
const CROP_EASING = "cubic-in-out";
// A hard flip toggle isn't a smooth animation -- Creatomate's Easing union
// has no step/hold value, so it's expressed as two keyframes this close
// together instead.
const FLIP_KEYFRAME_EPSILON_SECONDS = 1 / 60;
const CUT_TRANSITION_EASING = "linear";

/** Maps a cutTransitionInId (see cutTransitionPresets.ts) to the real
 * Creatomate SDK animation class that renders it -- SlideLeft/WipeLeft are
 * the one fixed smart-default direction for each type (no direction picker,
 * per this project's driving vision). `durationSeconds` is always the
 * segment's own already-computed cutTransitionOverlapSeconds (the overlap
 * this file's own buildRenderSegments/buildMediaSegments already placed the
 * two elements' `time`s to create -- see this file's module comment on why
 * the overlap is computed here rather than left to Creatomate's own
 * transition-property auto-shift). */
function getCreatomateCutTransitionAnimation(id: CutTransitionId, durationSeconds: number) {
  switch (id) {
    case "fade":
      return new Fade({ duration: durationSeconds, easing: CUT_TRANSITION_EASING });
    case "slide":
      return new SlideLeft({ duration: durationSeconds, easing: CUT_TRANSITION_EASING });
    case "wipe":
      return new WipeLeft({ duration: durationSeconds, easing: CUT_TRANSITION_EASING });
  }
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function pct(value: number): string {
  return `${value * 100}%`;
}

/** Inverse of the crop rect -- the transform on the OVERSIZED inner video
 * that makes only the cropped region visible through a same-size,
 * clip:true viewport. Anchored top-left (xAnchor/yAnchor '0%') so x/y
 * address the video's own top-left corner directly. */
function cropRectToVideoTransform(crop: CropRect) {
  return {
    width: pct(1 / crop.width),
    height: pct(1 / crop.height),
    x: pct(-crop.x / crop.width),
    y: pct(-crop.y / crop.height),
  };
}

/** Breakpoint times (GLOBAL/original-timeline seconds) where the effective
 * crop rect's slope changes within [segStart, segEnd) -- the segment's own
 * bounds plus every overlapping ZoomEffect's start/epicenter/end, clamped
 * into the segment. */
function findCropBreakpoints(zoomEffects: ZoomEffect[], segStart: number, segEnd: number): number[] {
  const points = new Set<number>([segStart, segEnd]);
  for (const effect of zoomEffects) {
    if (effect.endTimeSeconds <= segStart || effect.startTimeSeconds >= segEnd) continue;
    for (const t of [effect.startTimeSeconds, effect.epicenterTimeSeconds, effect.endTimeSeconds]) {
      if (t > segStart && t < segEnd) points.add(t);
    }
  }
  return Array.from(points).sort((a, b) => a - b);
}

/** Builds the crop x/y/width/height properties (plain values, or Keyframe
 * arrays when a ZoomEffect overlaps this segment) for one Video element.
 *
 * `baseCropRect`/a user-dragged pan-zoom ZoomEffect are authored against
 * the sequence's REFERENCE clip (the first one), not this segment's own --
 * reused verbatim against a segment whose own real aspect ratio differs,
 * the sampled region would no longer match the output frame's own ratio
 * and get non-uniformly stretched instead of cleanly cropped. Re-projected
 * here via reprojectCropRect before handing off to cropRectToVideoTransform,
 * UNLESS this segment is an image clip's own Ken Burns motion (built from
 * that photo's own cropRect, imageTemplates.ts's buildKenBurnsEffect --
 * already correctly scoped to this segment's own aspect ratio, so
 * re-projecting it FROM the reference clip's would be wrong). Also skipped
 * whenever `baseCropRect` itself is null -- no clip rectangle ratio was
 * ever chosen, so every clip already shows its own full native frame
 * (FULL_FRAME_CROP_RECT) regardless of aspect ratio, and reprojectCropRect
 * must not be called against that value (see its own doc comment) -- or
 * whenever either aspect ratio is unknown (referenceAspectRatio null, or
 * this segment's own width/height wasn't probed), the pre-fix behavior,
 * rather than guessing. */
function buildCropProperties(
  segment: RenderSegment,
  baseCropRect: CropRect | null,
  zoomEffects: ZoomEffect[],
  referenceAspectRatio: number | null
) {
  const segStart = segment.sourceStartSeconds;
  const segEnd = segment.sourceStartSeconds + segment.durationSeconds;
  const base = baseCropRect ?? FULL_FRAME_CROP_RECT;
  const segmentAspectRatio = segment.width && segment.height ? segment.width / segment.height : null;
  const reproject = (crop: CropRect): CropRect =>
    baseCropRect === null || segment.kind === "image" || referenceAspectRatio === null || segmentAspectRatio === null
      ? crop
      : reprojectCropRect(crop, referenceAspectRatio, segmentAspectRatio);

  const overlaps = zoomEffects.some((effect) => effect.endTimeSeconds > segStart && effect.startTimeSeconds < segEnd);
  if (!overlaps) {
    return cropRectToVideoTransform(reproject(computeEffectiveCropRect(base, zoomEffects, segStart)));
  }

  const breakpoints = findCropBreakpoints(zoomEffects, segStart, segEnd);
  const width: Keyframe<string>[] = [];
  const height: Keyframe<string>[] = [];
  const x: Keyframe<string>[] = [];
  const y: Keyframe<string>[] = [];

  for (const t of breakpoints) {
    const crop = reproject(computeEffectiveCropRect(base, zoomEffects, t));
    const transform = cropRectToVideoTransform(crop);
    // SEGMENT-LOCAL TIME -- see this file's module comment.
    const localTime = t - segStart;
    width.push(new Keyframe(transform.width, localTime, CROP_EASING));
    height.push(new Keyframe(transform.height, localTime, CROP_EASING));
    x.push(new Keyframe(transform.x, localTime, CROP_EASING));
    y.push(new Keyframe(transform.y, localTime, CROP_EASING));
  }

  return { width, height, x, y };
}

interface CanvasFillInfo {
  mode: CanvasFillMode;
  color?: string;
  gradientColor?: string;
}

/** The full-bleed backdrop for a "blur"/"solid"/"gradient" canvas-fill
 * segment -- always sized to fill the whole 100%x100% viewport, drawn
 * FIRST inside the wrapping Composition this function's caller builds (see
 * buildMediaSegments' own doc comment on why array order, not `track`,
 * decides which layer is on top here). "solid"/"gradient" use a Rectangle
 * (Shape) -- no asset/appMeta entry needed, it's a plain fill, not footage.
 * "blur" duplicates the same clip (own id + own appMeta entry pointing at
 * the SAME assetId, same "one asset, multiple elements" pattern this file
 * already uses for a cut-transition's overlap pair) at `fit: "cover"`, with
 * `blurRadius` set -- a first-class Creatomate element property, verified
 * against node_modules/creatomate/src/elements/ElementBase.ts, not a hack.
 * Always muted (Video only -- an Image has no audio to mute) so a clip
 * never plays its own audio twice through two elements at once. */
function buildCanvasFillBackground(
  segment: RenderSegment,
  fill: CanvasFillInfo,
  filter: ReturnType<typeof getCreatomateFilterProperties>,
  appMeta: Record<string, AppMetaEntry>,
  blurRadiusPx: number
): Video | Image | Rectangle {
  if (fill.mode === "solid") {
    return new Rectangle({
      id: nextId("clip-bg"),
      time: segment.outputStartSeconds,
      duration: segment.durationSeconds,
      fillMode: "solid",
      fillColor: fill.color ?? DEFAULT_CANVAS_FILL_COLOR,
    });
  }
  if (fill.mode === "gradient") {
    return new Rectangle({
      id: nextId("clip-bg"),
      time: segment.outputStartSeconds,
      duration: segment.durationSeconds,
      fillMode: "linear",
      // UNVERIFIED ASSUMPTION (this file's own module comment already flags
      // one of these -- this is the second): ShapeProperties.fillColor's own
      // doc says an array of color stops is valid for fillMode
      // "linear"/"radial" but "use the template designer to see how color
      // stops are formatted" -- no further detail in the installed SDK
      // source. A plain [start, end] string array is expandProperties'
      // pass-through case (utility/expandProperties.ts only special-cases
      // an array of real Keyframe instances), so this at least serializes
      // as-is rather than being silently mangled -- but if a real test
      // render shows Creatomate expects a different per-stop shape (e.g.
      // "0% #rrggbb" strings, or {color,offset} objects), this is the one
      // line to fix.
      fillColor: [fill.color ?? DEFAULT_CANVAS_FILL_COLOR, fill.gradientColor ?? DEFAULT_CANVAS_FILL_GRADIENT_COLOR] as unknown as string,
      fillX0: "50%",
      fillY0: "0%",
      fillX1: "50%",
      fillY1: "100%",
    });
  }

  // "blur"
  const id = nextId("clip-bg");
  appMeta[id] = { role: "clip", assetId: segment.assetId };
  const common = {
    id,
    time: segment.outputStartSeconds,
    duration: segment.durationSeconds,
    fit: "cover" as const,
    xAnchor: "0%",
    yAnchor: "0%",
    blurRadius: blurRadiusPx,
    ...filter,
    // Overwritten server-side by resolveAssetSources, same as every other
    // element's placeholder source below.
    source: "",
  };
  if (segment.kind === "image") return new Image(common);
  return new Video({ ...common, trimStart: segment.clipLocalStartSeconds, trimDuration: segment.durationSeconds, volume: "0%" });
}

/** One Video or Image element per RenderSegment (or, for a segment whose
 * own canvasFillMode isn't "crop", a small Composition wrapping a full-bleed
 * backdrop plus that same foreground -- see buildCanvasFillBackground
 * above), all on track 1 of their shared parent (sequenced back-to-back,
 * same convention as the README's multi-clip example). An image segment
 * gets no trimStart/trimDuration (meaningless for a still image -- it has no
 * timeline of its own to trim into), but otherwise reuses buildCropProperties
 * verbatim: Image's x/y/width/height/xAnchor/yAnchor are the same
 * ValueOrKeyframes-typed properties Video's are (both extend the SDK's
 * shared ElementBase/ElementProperties -- verified directly against
 * node_modules/creatomate/src/elements/{Image, ElementBase}.ts), so the
 * exact same keyframed crop transform applies to either element type
 * unchanged.
 *
 * Returns TWO parallel arrays, not one: `wrapperChildren` (what
 * buildFlipWrapper's own `elements` gets -- a Composition for a canvas-fill
 * segment, the plain Video/Image otherwise) and `foregroundBySegment` (the
 * REAL per-segment media element either way, same length/order as
 * `segments`) -- transcript captions (`transcriptSource`) and the
 * audioFadeOut crossfade mutation below both need the actual foreground
 * element, never the wrapping Composition, to look it up by segment index. */
function buildMediaSegments(
  segments: RenderSegment[],
  baseCropRect: CropRect | null,
  zoomEffects: ZoomEffect[],
  appMeta: Record<string, AppMetaEntry>,
  mainVolumePercent: string,
  cutawayFilterByEntryId: Map<string, FilterPresetId | null>,
  canvasFillByEntryId: Map<string, CanvasFillInfo>,
  referenceAspectRatio: number | null,
  outputWidth: number,
  outputHeight: number
): { wrapperChildren: (Video | Image | Composition)[]; foregroundBySegment: (Video | Image)[] } {
  const wrapperChildren: (Video | Image | Composition)[] = [];
  const foregroundBySegment: (Video | Image)[] = [];
  const blurRadiusPx = CANVAS_FILL_BLUR_RADIUS_FRACTION * Math.max(outputWidth, outputHeight);

  segments.forEach((segment, index) => {
    const filter = getCreatomateFilterProperties(
      segment.entryId ? (cutawayFilterByEntryId.get(segment.entryId) ?? null) : null
    );
    // Both the transition ANIMATION (renders the blend) and this element's
    // own `time` (segment.outputStartSeconds, already shifted earlier by
    // buildRenderSegments) come from the SAME cutTransitionInId/
    // cutTransitionOverlapSeconds this segment already carries -- nothing
    // here recomputes the overlap.
    const cutTransition =
      segment.cutTransitionInId && segment.cutTransitionOverlapSeconds
        ? { transition: getCreatomateCutTransitionAnimation(segment.cutTransitionInId, segment.cutTransitionOverlapSeconds) }
        : {};
    const fill = (segment.entryId ? canvasFillByEntryId.get(segment.entryId) : undefined) ?? { mode: "crop" as const };
    // Audio crossfade companion to the video blend above -- the incoming
    // clip's own volume ramps up from silence across the overlap instead of
    // starting at full volume mid-blend (an anchor keyframe at t=0 is
    // required, same reasoning as buildFlipScaleKeyframes' own anchor
    // keyframes: Creatomate has nothing to interpolate FROM otherwise). Uses
    // the SDK's own audioFadeIn/audioFadeOut (Video-specific, NOT a
    // ValueOrKeyframes property -- volume itself only accepts a flat
    // number/string, see node_modules/creatomate/dist/elements/Video.d.ts)
    // rather than hand-rolled Keyframe volume automation -- same "trust the
    // real SDK properties" philosophy this file's own module comment states.
    const overlapSeconds = segment.cutTransitionOverlapSeconds ?? 0;

    if (fill.mode !== "crop") {
      // Letterboxed/pillarboxed instead of cropped -- bypasses
      // buildCropProperties/zoomEffects entirely for this segment (a
      // specific authored crop-and-zoom and full-frame letterboxing are
      // conflicting goals; honoring the letterbox is what turning this on
      // means). `fit: "contain"` lets Creatomate do the letterbox math
      // itself -- no manual crop transform needed, unlike the "crop" case
      // below.
      const id = nextId("clip");
      appMeta[id] = { role: "clip", assetId: segment.assetId };
      const foregroundCommon = {
        id,
        time: segment.outputStartSeconds,
        duration: segment.durationSeconds,
        fit: "contain" as const,
        xAnchor: "0%",
        yAnchor: "0%",
        ...filter,
        ...cutTransition,
        source: "",
      };
      const foreground =
        segment.kind === "image"
          ? new Image(foregroundCommon)
          : new Video({
              ...foregroundCommon,
              trimStart: segment.clipLocalStartSeconds,
              trimDuration: segment.durationSeconds,
              volume: mainVolumePercent,
              ...(overlapSeconds > 0 ? { audioFadeIn: overlapSeconds } : {}),
            });
      const background = buildCanvasFillBackground(segment, fill, filter, appMeta, blurRadiusPx);
      wrapperChildren.push(
        new Composition({
          id: nextId("canvas-fill"),
          track: 1,
          time: segment.outputStartSeconds,
          duration: segment.durationSeconds,
          x: "0%",
          y: "0%",
          width: "100%",
          height: "100%",
          elements: [background, foreground],
        })
      );
      foregroundBySegment.push(foreground);

      const previous = index > 0 ? foregroundBySegment[foregroundBySegment.length - 2] : undefined;
      if (overlapSeconds > 0 && previous instanceof Video) {
        previous.properties.audioFadeOut = overlapSeconds;
      }
      return;
    }

    const crop = buildCropProperties(segment, baseCropRect, zoomEffects, referenceAspectRatio);

    if (segment.kind === "image") {
      const id = nextId("clip");
      appMeta[id] = { role: "clip", assetId: segment.assetId };
      const element = new Image({
        id,
        track: 1,
        time: segment.outputStartSeconds,
        duration: segment.durationSeconds,
        fit: "fill",
        xAnchor: "0%",
        yAnchor: "0%",
        ...crop,
        ...filter,
        ...cutTransition,
        // Overwritten server-side by resolveAssetSources (api/render/route.ts)
        // from _appMeta[id].assetId -- never a real playable URL by itself.
        source: "",
      });
      wrapperChildren.push(element);
      foregroundBySegment.push(element);
      return;
    }

    const id = nextId("clip");
    appMeta[id] = { role: "clip", assetId: segment.assetId };
    const element = new Video({
      id,
      track: 1,
      time: segment.outputStartSeconds,
      duration: segment.durationSeconds,
      trimStart: segment.clipLocalStartSeconds,
      trimDuration: segment.durationSeconds,
      fit: "fill",
      xAnchor: "0%",
      yAnchor: "0%",
      volume: mainVolumePercent,
      ...(overlapSeconds > 0 ? { audioFadeIn: overlapSeconds } : {}),
      ...crop,
      ...filter,
      ...cutTransition,
      // Overwritten server-side by resolveAssetSources (api/render/route.ts)
      // from _appMeta[id].assetId -- never a real playable URL by itself.
      source: "",
    });
    wrapperChildren.push(element);
    foregroundBySegment.push(element);

    // The OUTGOING side of this same crossfade -- the element immediately
    // preceding this one fades ITS OWN tail out via the same audioFadeOut
    // property. Only when that element is itself a Video (an Image segment
    // has no audio, hence no audioFadeOut, at all).
    const previous = index > 0 ? foregroundBySegment[foregroundBySegment.length - 2] : undefined;
    if (overlapSeconds > 0 && previous instanceof Video) {
      previous.properties.audioFadeOut = overlapSeconds;
    }
  });

  return { wrapperChildren, foregroundBySegment };
}

/** The flip/mirror wrapper -- one composition spanning the WHOLE output
 * timeline (flip toggles are authored globally, not per-segment, and can
 * land mid-segment), center-anchored so xScale/yScale mirror in place.
 * Holds every video segment as its own children. Returns a plain
 * Composition (no crop keyframes of its own) when there's nothing to
 * flip on either axis, to avoid emitting pointless static 100% keyframes. */
function buildFlipWrapper(
  mediaSegments: (Video | Image | Composition)[],
  flipHorizontalToggles: number[],
  flipVerticalToggles: number[],
  totalOutputDurationSeconds: number
): Composition {
  const xScale = buildFlipScaleKeyframes(flipHorizontalToggles, totalOutputDurationSeconds);
  const yScale = buildFlipScaleKeyframes(flipVerticalToggles, totalOutputDurationSeconds);

  return new Composition({
    id: nextId("flip-wrapper"),
    track: 1,
    x: "50%",
    y: "50%",
    width: "100%",
    height: "100%",
    xAnchor: "50%",
    yAnchor: "50%",
    ...(xScale ? { xScale } : {}),
    ...(yScale ? { yScale } : {}),
    elements: mediaSegments,
  });
}

function buildFlipScaleKeyframes(toggles: number[], totalDurationSeconds: number): Keyframe<string>[] | null {
  if (toggles.length === 0) return null;
  const segments = computeFlipSegments(toggles, totalDurationSeconds);
  const keyframes: Keyframe<string>[] = [new Keyframe("100%", 0)];

  for (const segment of segments) {
    const onAt = Math.max(0, segment.startTimeSeconds - FLIP_KEYFRAME_EPSILON_SECONDS);
    keyframes.push(new Keyframe("100%", onAt));
    keyframes.push(new Keyframe("-100%", segment.startTimeSeconds));
    if (segment.endTimeSeconds < totalDurationSeconds) {
      const offAt = Math.max(segment.startTimeSeconds, segment.endTimeSeconds - FLIP_KEYFRAME_EPSILON_SECONDS);
      keyframes.push(new Keyframe("-100%", offAt));
      keyframes.push(new Keyframe("100%", segment.endTimeSeconds));
    }
  }
  return keyframes;
}

function rectProperties(rect: CropRect) {
  return { x: pct(rect.x), y: pct(rect.y), width: pct(rect.width), height: pct(rect.height) };
}

/** Same as rectProperties, but for an anchor other than the rect's own
 * top-left corner -- x/y move to the anchor point (e.g. the rect's center)
 * instead of staying at the corner, so xAnchor/yAnchor and x/y can never
 * drift out of sync. Pairs an anchor switch with its position recompute in
 * one place; anchorX/anchorY are 0..1 fractions of the rect ("0" = the
 * corner rectProperties uses, "0.5" = center). */
function anchoredRectProperties(rect: CropRect, anchorX: number, anchorY: number) {
  return {
    x: pct(rect.x + rect.width * anchorX),
    y: pct(rect.y + rect.height * anchorY),
    width: pct(rect.width),
    height: pct(rect.height),
    xAnchor: pct(anchorX),
    yAnchor: pct(anchorY),
  };
}

/** Image overlays -- root-level siblings of the crop viewport, since their
 * rect is a fraction of the OUTPUT frame (post-crop), matching
 * CanvasPlayer's own compositing order (drawn after the flip transform is
 * undone). One element per surviving output sub-range -- more than one if
 * a trim cuts through the middle of the overlay's authored window. Sized to
 * whatever computeOverlayRects says for its layout (full frame for
 * Full-Screen, a Picture-in-Picture box, or a Split Screen half) -- same
 * layout-aware positioning buildVideoOverlayElements already does for video
 * overlays, since ImageOverlayClip shares the exact same VideoOverlayLayout
 * union.
 *
 * KNOWN GAP: unlike buildVideoOverlayElements, this does NOT reproduce
 * `overlay.framing` (pan/zoom/flip) or a Split-Screen half's own
 * `baseFraming` -- `fit: "cover"` below always centers, same documented gap
 * buildVideoOverlayElements already carries for its own framing.panX/panY,
 * and for the same reason (this whole path isn't reachable from the UI yet
 * regardless -- see ThreePaneEditor.tsx's handleRenderClick). */
function buildOverlayImageElements(
  overlayImages: EditSelectionsSnapshot["overlayImages"],
  segments: RenderSegment[],
  nextTrack: () => number,
  appMeta: Record<string, AppMetaEntry>
): Image[] {
  const elements: Image[] = [];
  for (const overlay of overlayImages) {
    const track = nextTrack();
    const { overlayRect } = computeOverlayRects(overlay.layout);
    const outputRanges = mapSourceRangeToOutputRanges(segments, overlay.startTimeSeconds, overlay.endTimeSeconds);
    const filter = getCreatomateFilterProperties(overlay.colorFilterId ?? null);
    for (const range of outputRanges) {
      const id = nextId("overlay");
      appMeta[id] = { role: "image-overlay", assetId: overlay.assetId };
      elements.push(
        new Image({
          id,
          track,
          time: range.outputStartSeconds,
          duration: range.outputEndSeconds - range.outputStartSeconds,
          fit: "cover",
          xAnchor: "0%",
          yAnchor: "0%",
          ...rectProperties(overlayRect),
          ...filter,
          source: "",
        })
      );
    }
  }
  return elements;
}

/** One root-level Video element per surviving output sub-range, for a
 * VIDEO overlay's own footage -- sized to whatever computeOverlayRects
 * says for its layout (full frame for Full-Screen, a Picture-in-Picture
 * box, or a Split Screen half). NOT nested inside cropViewport: ignores
 * the base clip's crop/zoom/flip entirely (matches CanvasPlayer's own
 * draw order/tier -- drawn after the base's flip transform is undone).
 * One function handles every layout, since from the compiler's point of
 * view it's always just "the overlay's own Video, at this rect."
 *
 * KNOWN GAP: `overlay.audioBalance` (video_math.ts's VideoOverlayClip --
 * lets the live preview duck the base track and mix in the overlay's own
 * audio, see CanvasPlayer.tsx's computeAudioMixBreakpoints/sampleAudioMixAt)
 * is not reflected here at all -- every overlay's own `Video` element below
 * plays with Creatomate's own default audio behavior, and the base track's
 * volume is never ducked. The same gap extends to the three-way main/
 * overlay/TTS-narration mix sampleAudioMixAt now describes: buildTtsOverlayElements'
 * own `Audio` element below plays at a flat `overlay.volume`, with no
 * corresponding duck of either the base track or an overlapping overlay's
 * `Video` element. Reproducing any of this server-side would need per-
 * element `volume` (for each clip's own share) plus keyframed volume
 * automation on the base sequence's own Video elements (for ducking) --
 * real, uncharted-for-this-file work, not attempted here since this whole
 * path isn't reachable from the UI yet regardless (see
 * ThreePaneEditor.tsx's handleRenderClick). */
function buildVideoOverlayElements(
  videoOverlays: VideoOverlayClip[],
  segments: RenderSegment[],
  nextTrack: () => number,
  appMeta: Record<string, AppMetaEntry>,
  videoOverlaySourceDurations: Record<string, number>
): (Video | Composition)[] {
  const elements: (Video | Composition)[] = [];
  for (const overlay of videoOverlays) {
    const track = nextTrack();
    const { overlayRect } = computeOverlayRects(overlay.layout);
    const sourceDurationSeconds = videoOverlaySourceDurations[overlay.assetId];
    // Only loop when we actually know the source is shorter than the
    // window -- an unknown duration falls back to the old single-play
    // behavior rather than guessing.
    const shouldLoop = sourceDurationSeconds !== undefined && sourceDurationSeconds > 0 && sourceDurationSeconds < overlay.endTimeSeconds - overlay.startTimeSeconds;
    // KNOWN LIMITATION: if `shouldLoop` is true AND a trim cut splits this
    // overlay into more than one outputRange below, `trimStart` for the
    // second-and-later ranges is computed as if the source never wrapped --
    // correct for the FIRST range, but potentially wrong for a later one
    // that starts partway through a second (or later) loop cycle. Verified
    // fine for the common case (no trim cut through an active overlay); a
    // real test render is needed before relying on the split+loop
    // combination specifically (this whole path isn't reachable from the
    // UI yet regardless -- see ThreePaneEditor.tsx's handleRenderClick,
    // which shows a "coming soon" popup instead of ever calling this).
    //
    // KNOWN LIMITATION: `framing.panX`/`panY` (video_math.ts's
    // OverlayFraming) are NOT applied here -- reproducing them server-side
    // needs the source asset's own pixel aspect ratio, which nothing
    // gathers today (CanvasPlayer knows it client-side, from the loaded
    // frame's naturalWidth/naturalHeight, but that's never sent to this
    // compiler). `fit: "cover"` below always centers, same as before this
    // feature existed. `flipHorizontal`/`flipVertical` ARE applied (they
    // don't need aspect-ratio info -- see the wrapping Composition below,
    // same xScale/yScale-mirror technique buildFlipWrapper already uses
    // for the whole frame, just centered on this element's own box instead).
    const needsFlipWrapper = overlay.framing.flipHorizontal || overlay.framing.flipVertical;
    const outputRanges = mapSourceRangeToOutputRanges(segments, overlay.startTimeSeconds, overlay.endTimeSeconds);
    const filter = getCreatomateFilterProperties(overlay.colorFilterId ?? null);
    for (const range of outputRanges) {
      const id = nextId("overlay");
      appMeta[id] = { role: "video-overlay", assetId: overlay.assetId };
      const trimStart = overlay.sourceStartSeconds + (range.sourceOverlapStartSeconds - overlay.startTimeSeconds);
      const video = new Video({
        id,
        track,
        time: range.outputStartSeconds,
        duration: range.outputEndSeconds - range.outputStartSeconds,
        trimStart,
        // One play-through's worth when looping (Creatomate repeats the
        // trimmed range to fill `duration`); otherwise the old
        // "trim exactly this sub-range" behavior.
        trimDuration: shouldLoop ? sourceDurationSeconds : range.outputEndSeconds - range.outputStartSeconds,
        ...(shouldLoop ? { loop: true } : {}),
        fit: "cover",
        // Full-frame relative to its own wrapping Composition when flipped
        // (see below); otherwise positioned directly at overlayRect same as
        // before.
        ...(needsFlipWrapper
          ? { x: "0%", y: "0%", width: "100%", height: "100%", xAnchor: "0%", yAnchor: "0%" }
          : { ...rectProperties(overlayRect), xAnchor: "0%", yAnchor: "0%" }),
        ...filter,
        source: "",
      });

      if (!needsFlipWrapper) {
        elements.push(video);
        continue;
      }
      elements.push(
        new Composition({
          id: nextId("overlay-flip"),
          track,
          ...anchoredRectProperties(overlayRect, 0.5, 0.5),
          xScale: overlay.framing.flipHorizontal ? "-100%" : "100%",
          yScale: overlay.framing.flipVertical ? "-100%" : "100%",
          clip: true,
          elements: [video],
        })
      );
    }
  }
  return elements;
}

/** Keyframes cropViewport's OWN x/y/width/height -- full frame outside
 * every Split Screen window, shrunk/repositioned to the base clip's half
 * inside one. Everything nested inside cropViewport (flipWrapper, the
 * per-segment crop elements) is UNTOUCHED -- their percentages are
 * relative to this container, so re-boxing the container alone reproduces
 * the correct cropped+flipped picture at half size. Full-Screen/
 * Picture-in-Picture overlays never call this -- their windows leave
 * cropViewport static (a Full-Screen overlay's own opaque element already
 * fully covers the base regardless of its own viewport's shape; a
 * Picture-in-Picture box doesn't touch the base's shape at all). Hard-cut,
 * epsilon-separated step keyframes, same convention as buildFlipWrapper's
 * own keyframes. Returns null (leave cropViewport static) when there are
 * no Split Screen windows, to avoid emitting pointless keyframes. Takes a
 * combined video+image overlay array (see this function's own call site) --
 * generic over just the fields this needs, since a Split-Screen window
 * reshapes the viewport the same way regardless of which clip type it
 * came from. */
function buildOverlayCropViewportRect(
  overlays: { layout: VideoOverlayClip["layout"]; startTimeSeconds: number; endTimeSeconds: number }[],
  segments: RenderSegment[]
): { x: Keyframe<string>[]; y: Keyframe<string>[]; width: Keyframe<string>[]; height: Keyframe<string>[] } | null {
  const splitScreenOverlays = overlays.filter((overlay) => overlay.layout.type === "split-screen");
  if (splitScreenOverlays.length === 0) return null;

  const FULL = { x: "0%", y: "0%", width: "100%", height: "100%" };
  const x = [new Keyframe(FULL.x, 0)];
  const y = [new Keyframe(FULL.y, 0)];
  const width = [new Keyframe(FULL.width, 0)];
  const height = [new Keyframe(FULL.height, 0)];

  const windows = splitScreenOverlays
    .flatMap((overlay) => {
      const { baseRect } = computeOverlayRects(overlay.layout);
      return mapSourceRangeToOutputRanges(segments, overlay.startTimeSeconds, overlay.endTimeSeconds).map((range) => ({
        ...range,
        baseRect: baseRect!, // always defined for a split-screen layout
      }));
    })
    .sort((a, b) => a.outputStartSeconds - b.outputStartSeconds);

  for (const w of windows) {
    const rect = rectProperties(w.baseRect);
    const onAt = Math.max(0, w.outputStartSeconds - FLIP_KEYFRAME_EPSILON_SECONDS);
    const offAt = Math.max(w.outputStartSeconds, w.outputEndSeconds - FLIP_KEYFRAME_EPSILON_SECONDS);
    x.push(new Keyframe(FULL.x, onAt), new Keyframe(rect.x, w.outputStartSeconds), new Keyframe(rect.x, offAt), new Keyframe(FULL.x, w.outputEndSeconds));
    y.push(new Keyframe(FULL.y, onAt), new Keyframe(rect.y, w.outputStartSeconds), new Keyframe(rect.y, offAt), new Keyframe(FULL.y, w.outputEndSeconds));
    width.push(new Keyframe(FULL.width, onAt), new Keyframe(rect.width, w.outputStartSeconds), new Keyframe(rect.width, offAt), new Keyframe(FULL.width, w.outputEndSeconds));
    height.push(new Keyframe(FULL.height, onAt), new Keyframe(rect.height, w.outputStartSeconds), new Keyframe(rect.height, offAt), new Keyframe(FULL.height, w.outputEndSeconds));
  }
  return { x, y, width, height };
}

/** Text overlays -- same root-level/output-fraction placement as image
 * overlays. fontSizeMinimum/fontSizeMaximum + textWrap replace a fixed
 * fontSize, mirroring lib/video/textTemplates.ts's own wrap-to-fit fix
 * rather than a single unwrapped size. Per-template style/animation
 * mapping lives in getCreatomateTextStyle (textTemplates.ts) so the
 * canvas-preview templates and this compiler can't drift independently. */
function buildTextElements(
  textOverlays: EditSelectionsSnapshot["textOverlays"],
  segments: RenderSegment[],
  nextTrack: () => number
): Text[] {
  const elements: Text[] = [];
  for (const overlay of textOverlays) {
    const track = nextTrack();
    const outputRanges = mapSourceRangeToOutputRanges(segments, overlay.startTimeSeconds, overlay.endTimeSeconds);
    for (const range of outputRanges) {
      const durationSeconds = range.outputEndSeconds - range.outputStartSeconds;
      const fontFraction = getTextTemplateFontFraction(overlay.templateId);
      const anchor = getTextTemplateAnchorFraction(overlay.templateId);
      elements.push(
        new Text({
          id: nextId("text"),
          track,
          time: range.outputStartSeconds,
          duration: durationSeconds,
          text: overlay.text,
          textWrap: true,
          fontSizeMinimum: "2vh",
          fontSizeMaximum: `${fontFraction * 100}vh`,
          ...anchoredRectProperties(overlay.rect, anchor.x, anchor.y),
          ...buildTextTemplateStyle(overlay.templateId, durationSeconds),
        })
      );
    }
  }
  return elements;
}

/** Templates whose entrance animation scales from the middle (Bold Pop,
 * Bounce In) need a center anchor so xScale/yScale zooms from the box's
 * actual center rather than its top-left corner. Every other template
 * anchors at the rect's own corner. Read by anchoredRectProperties'
 * callers below -- kept as the one place this is decided so a template's
 * anchor and its x/y recompute can't drift apart, same pairing
 * buildVideoOverlayElements' flip wrapper already does for its own
 * center-anchored Composition. */
const CENTER_ANCHORED_TEXT_TEMPLATES = new Set(["bold-pop", "bounce-in"]);

function getTextTemplateAnchorFraction(templateId: string): { x: number; y: number } {
  return CENTER_ANCHORED_TEXT_TEMPLATES.has(templateId) ? { x: 0.5, y: 0.5 } : { x: 0, y: 0 };
}

/** Per-template style + entrance animation. DIY scale-in entrances
 * (Bold Pop, Bounce In) use property keyframes directly on xScale/yScale
 * rather than Creatomate's canned Bounce/TextScale animation classes,
 * which describe a different motion (a repeated bounce, or a scale with
 * no controllable start value) than our one-shot pop -- see the plan's
 * mapping table for why each template's animation was chosen. Anchor is
 * NOT set here -- see getTextTemplateAnchorFraction/anchoredRectProperties,
 * called by this function's callers before this style is spread on top. */
function buildTextTemplateStyle(templateId: string, durationSeconds: number): Record<string, unknown> {
  switch (templateId) {
    case "bold-pop":
      return {
        fontWeight: 700,
        fillColor: "#ffffff",
        strokeColor: "#000000",
        strokeWidth: "2%",
        xScale: [new Keyframe("80%", 0, CROP_EASING), new Keyframe("100%", durationSeconds * 0.2, CROP_EASING)],
        yScale: [new Keyframe("80%", 0, CROP_EASING), new Keyframe("100%", durationSeconds * 0.2, CROP_EASING)],
      };
    case "minimal-subtitle":
      return {
        fillColor: "#ffffff",
        backgroundColor: "rgba(0,0,0,0.6)",
        backgroundXPadding: "20%",
        backgroundYPadding: "20%",
        opacity: [new Keyframe(0, 0, CROP_EASING), new Keyframe(1, durationSeconds * 0.1, CROP_EASING)],
      };
    case "typewriter":
      return {
        fontFamily: "Roboto Mono",
        fillColor: "#ffffff",
        strokeColor: "#000000",
        strokeWidth: "1%",
        xAlignment: "0%",
        enter: new TextTypewriter({ typingStart: 0, typingDuration: durationSeconds }),
      };
    case "bounce-in":
      return {
        fontWeight: 700,
        fillColor: "#ffffff",
        strokeColor: "#000000",
        strokeWidth: "2%",
        xScale: [new Keyframe("50%", 0, "back-out"), new Keyframe("100%", durationSeconds * 0.35, "back-out")],
        yScale: [new Keyframe("50%", 0, "back-out"), new Keyframe("100%", durationSeconds * 0.35, "back-out")],
      };
    case "highlight-box":
      return {
        fontWeight: 700,
        fillColor: "#1c1917",
        backgroundColor: "#facc15",
        backgroundXPadding: "15%",
        backgroundYPadding: "15%",
        backgroundBorderRadius: "15%",
        opacity: [new Keyframe(0, 0, CROP_EASING), new Keyframe(1, durationSeconds * 0.1, CROP_EASING)],
      };
    case "neon-glow":
      return {
        fontWeight: 700,
        fillColor: "#f0abfc",
        shadowColor: "#e879f9",
        shadowBlur: "3vh",
        opacity: [new Keyframe(0, 0, CROP_EASING), new Keyframe(1, durationSeconds * 0.15, CROP_EASING)],
      };
    case "word-pop":
      return {
        fontWeight: 700,
        fillColor: "#ffffff",
        strokeColor: "#000000",
        strokeWidth: "2%",
        enter: new TextAppearWordByWord({ duration: durationSeconds, fade: true, easing: CROP_EASING }),
      };
    default:
      return { fillColor: "#ffffff" };
  }
}

/** Background music -- mirrors BackgroundTrackStrip.tsx's own
 * concatenate-then-loop model. A single track is one looping Audio
 * element; multiple tracks are wrapped in a looping Composition so the
 * whole concatenated sequence repeats, not just its first track. */
function buildBackgroundAudioElement(
  backgroundClips: SequenceClipInfo[],
  totalOutputDurationSeconds: number,
  track: number,
  appMeta: Record<string, AppMetaEntry>,
  backgroundVolumePercent: string
): Audio | Composition | null {
  if (backgroundClips.length === 0 || totalOutputDurationSeconds <= 0) return null;

  if (backgroundClips.length === 1) {
    const id = nextId("music");
    appMeta[id] = { role: "music", assetId: backgroundClips[0].assetId };
    return new Audio({
      id,
      track,
      time: 0,
      duration: totalOutputDurationSeconds,
      loop: true,
      volume: backgroundVolumePercent,
      source: "",
    });
  }

  const loopDurationSeconds = totalSequenceDuration(backgroundClips);
  const children = backgroundClips.map((clip) => {
    const id = nextId("music");
    appMeta[id] = { role: "music", assetId: clip.assetId };
    return new Audio({
      id,
      track: 1,
      time: clip.startTimeSeconds,
      duration: clip.durationSeconds,
      volume: backgroundVolumePercent,
      source: "",
    });
  });

  return new Composition({
    id: nextId("music-loop"),
    track,
    time: 0,
    duration: totalOutputDurationSeconds,
    loop: true,
    plays: Math.ceil(totalOutputDurationSeconds / Math.max(loopDurationSeconds, 0.01)),
    elements: children,
  });
}

/** TTS narration -- one Audio element per surviving output sub-range (same
 * trim-splitting as every other time-ranged overlay, via
 * mapSourceRangeToOutputRanges), given a stable id (nextId("voiceover")) and appMeta role
 * "voiceover" so resolveAssetSources (api/render/route.ts) resolves it to a
 * fresh presigned URL the same generic way as every other referenced asset.
 * Each overlay gets TWO dedicated tracks (not one) -- its own Audio and its
 * own companion Text caption coexist in time by design (the caption
 * illustrates the audio playing underneath it), so they can't share a
 * single track the way e.g. buildTextElements' plain text overlays can
 * reuse one track across their own non-overlapping output ranges.
 *
 * Background mode's companion Text is built the same way buildTextElements
 * builds a manual caption (reusing buildTextTemplateStyle/
 * getTextTemplateFontFraction against overlay.templateId). Karaoke mode's
 * companion Text is driven by Creatomate's own transcriptSource/
 * transcriptEffect/transcriptSplit against THIS Audio element's own id --
 * mirrors buildTranscriptCaptionElements' shape closely, but against a
 * narration's own generated audio (known, exact word timings from the
 * synthesis itself) rather than ASR transcription of the base video.
 * `displayMode === "none"` (audio-only narration) skips the companion Text
 * entirely -- and, since there's nothing to caption, never allocates the
 * second (caption) track that mode would have used. */
function buildTtsOverlayElements(
  ttsOverlays: EditSelectionsSnapshot["ttsOverlays"],
  segments: RenderSegment[],
  nextTrack: () => number,
  appMeta: Record<string, AppMetaEntry>
): (Audio | Text)[] {
  const elements: (Audio | Text)[] = [];
  for (const overlay of ttsOverlays) {
    const audioTrack = nextTrack();
    const captionTrack = overlay.displayMode === "none" ? null : nextTrack();
    const overlayEndSeconds = overlay.startTimeSeconds + overlay.durationSeconds;
    const outputRanges = mapSourceRangeToOutputRanges(segments, overlay.startTimeSeconds, overlayEndSeconds);

    for (const range of outputRanges) {
      const durationSeconds = range.outputEndSeconds - range.outputStartSeconds;
      // `nextId("voiceover")` itself is this element's own stable,
      // human-legible identifier (e.g. "voiceover-7") -- the SDK's Audio
      // element has no separate `name` property to also set.
      const id = nextId("voiceover");
      appMeta[id] = { role: "voiceover", assetId: overlay.assetId };
      elements.push(
        new Audio({
          id,
          track: audioTrack,
          time: range.outputStartSeconds,
          duration: durationSeconds,
          volume: toVolumePercent(overlay.volume ?? 1),
          // Overwritten server-side by resolveAssetSources, same as every
          // other element's placeholder source below.
          source: "",
        })
      );

      if (captionTrack === null) continue; // "none" -- audio-only, no caption to build

      if (overlay.displayMode === "karaoke") {
        elements.push(
          new Text({
            id: nextId("tts-caption"),
            track: captionTrack,
            time: range.outputStartSeconds,
            duration: durationSeconds,
            transcriptSource: id,
            transcriptEffect: "karaoke",
            transcriptSplit: "word",
            transcriptColor: "#facc15",
            textWrap: true,
            fillColor: "#ffffff",
            xAnchor: "0%",
            yAnchor: "0%",
            ...rectProperties(overlay.rect),
          })
        );
      } else {
        const fontFraction = getTextTemplateFontFraction(overlay.templateId);
        const anchor = getTextTemplateAnchorFraction(overlay.templateId);
        elements.push(
          new Text({
            id: nextId("tts-caption"),
            track: captionTrack,
            time: range.outputStartSeconds,
            duration: durationSeconds,
            text: overlay.text,
            textWrap: true,
            fontSizeMinimum: "2vh",
            fontSizeMaximum: `${fontFraction * 100}vh`,
            ...anchoredRectProperties(overlay.rect, anchor.x, anchor.y),
            ...buildTextTemplateStyle(overlay.templateId, durationSeconds),
          })
        );
      }
    }
  }
  return elements;
}

/** Auto-generated (transcript) captions -- one Text element per VIDEO
 * RenderSegment, each transcribing that segment's own Video element
 * (transcriptSource takes exactly one video element's id, and the
 * sequence is already split into per-clip/per-trim Video elements -- see
 * video_math.ts's TranscriptCaption doc comment for why this is fine: a
 * caption naturally resets at a hard cut anyway). Image segments are
 * skipped entirely -- a still photo has no spoken audio to transcribe.
 * `videoSegmentPairs` pairs each VIDEO segment with the exact Video
 * element buildMediaSegments produced for it (not a plain index into
 * `segments`, since that array can also contain Image elements once image
 * clips exist). Root-level placement, same output-frame-relative rect
 * convention as image/text overlays. */
function buildTranscriptCaptionElements(
  transcriptCaption: TranscriptCaption | null,
  videoSegmentPairs: { segment: RenderSegment; element: Video }[],
  track: number
): Text[] {
  if (!transcriptCaption) return [];
  const config = getTranscriptCaptionConfig(transcriptCaption.templateId);

  return videoSegmentPairs.map(({ segment, element }) => {
    const sourceVideoId = element.properties.id as string;
    return new Text({
      id: nextId("transcript"),
      track,
      time: segment.outputStartSeconds,
      duration: segment.durationSeconds,
      transcriptSource: sourceVideoId,
      transcriptEffect: config.transcriptEffect,
      transcriptSplit: config.transcriptSplit,
      ...(config.transcriptColor ? { transcriptColor: config.transcriptColor } : {}),
      textWrap: true,
      fillColor: "#ffffff",
      xAnchor: "0%",
      yAnchor: "0%",
      ...rectProperties(transcriptCaption.rect),
    });
  });
}

export function compileCreatomateTimeline(input: CompileTimelineInput): Timeline {
  idCounter = 0;
  const {
    selections,
    sequenceClips,
    backgroundClips,
    outputWidth,
    outputHeight,
    videoOverlaySourceDurations = {},
    mainAudioVolume,
    backgroundVolume,
  } = input;
  const appMeta: Record<string, AppMetaEntry> = {};

  const totalOriginalDurationSeconds = totalSequenceDuration(sequenceClips);
  const cutTransitionByEntryId = new Map(selections.sequenceClips.map((entry) => [entry.id, entry.cutTransitionInId ?? null]));
  const segments = buildRenderSegments(sequenceClips, selections.trimRanges, cutTransitionByEntryId);
  // Overlapping segments overcount a naive sum -- see totalRenderOutputDuration's own doc comment.
  const totalOutputDurationSeconds = totalRenderOutputDuration(segments);

  const cutawayFilterByEntryId = new Map(selections.sequenceClips.map((entry) => [entry.id, entry.colorFilterId ?? null]));
  // Per-cutaway canvas-fill lookup, same "each clip carries its own"
  // shape as cutawayFilterByEntryId above -- see canvasFillPresets.ts.
  const canvasFillByEntryId = new Map(
    selections.sequenceClips.map((entry) => [
      entry.id,
      { mode: getCanvasFillMode(entry.canvasFillMode), color: entry.canvasFillColor, gradientColor: entry.canvasFillGradientColor },
    ])
  );
  // `selections.cropRect`/a user-dragged pan-zoom ZoomEffect are always
  // authored against the sequence's REFERENCE clip -- the first one (see
  // CanvasPlayer's referenceFrameSizeRef) -- and need re-projecting onto
  // each OTHER segment's own real aspect ratio before use; see
  // buildCropProperties/reprojectCropRect below.
  const referenceClip = sequenceClips[0];
  const referenceAspectRatio =
    referenceClip?.width && referenceClip?.height ? referenceClip.width / referenceClip.height : null;
  const { wrapperChildren, foregroundBySegment } = buildMediaSegments(
    segments,
    selections.cropRect,
    selections.zoomEffects,
    appMeta,
    toVolumePercent(mainAudioVolume),
    cutawayFilterByEntryId,
    canvasFillByEntryId,
    referenceAspectRatio,
    outputWidth,
    outputHeight
  );
  const videoSegmentPairs = segments
    .map((segment, index) => ({ segment, element: foregroundBySegment[index] }))
    .filter((pair): pair is { segment: RenderSegment; element: Video } => pair.segment.kind === "video");
  const flipWrapper = buildFlipWrapper(
    wrapperChildren,
    selections.flipHorizontalToggles,
    selections.flipVerticalToggles,
    totalOutputDurationSeconds
  );

  // Clamped/filtered against the CURRENT total duration for the same
  // "a since-shrunk sequence shouldn't leave a stale range" reason as
  // clampedOverlayImages/clampedTextOverlays below.
  const clampedVideoOverlays = selections.videoOverlays
    .map((overlay) => ({ ...overlay, endTimeSeconds: Math.min(overlay.endTimeSeconds, totalOriginalDurationSeconds) }))
    .filter((overlay) => overlay.startTimeSeconds < totalOriginalDurationSeconds);

  // Overlay/text-overlay ranges are re-clamped against the CURRENT total
  // duration before mapping -- a since-shrunk sequence (a clip removed
  // after the overlay was authored) could otherwise leave a stale range
  // pointing past the end.
  const clampedOverlayImages = selections.overlayImages
    .map((overlay) => ({ ...overlay, endTimeSeconds: Math.min(overlay.endTimeSeconds, totalOriginalDurationSeconds) }))
    .filter((overlay) => overlay.startTimeSeconds < totalOriginalDurationSeconds);

  // Split-Screen windows from EITHER array reshape the shared cropViewport
  // -- image wins ties, same convention as CanvasPlayer.tsx's compositing
  // order (see that file's own comment), reproduced here by simply passing
  // the image array SECOND so its windows sort after a same-instant video
  // one and win the "last keyframe wins" evaluation Creatomate does.
  const overlayCropViewportRect = buildOverlayCropViewportRect([...clampedVideoOverlays, ...clampedOverlayImages], segments);
  const cropViewport = new Composition({
    id: nextId("crop-viewport"),
    track: 1,
    ...(overlayCropViewportRect ?? { x: "0%", y: "0%", width: "100%", height: "100%" }),
    xAnchor: "0%",
    yAnchor: "0%",
    clip: true,
    elements: [flipWrapper],
  });

  const clampedTextOverlays = selections.textOverlays
    .map((overlay) => ({ ...overlay, endTimeSeconds: Math.min(overlay.endTimeSeconds, totalOriginalDurationSeconds) }))
    .filter((overlay) => overlay.startTimeSeconds < totalOriginalDurationSeconds);

  // Same "a since-shrunk sequence shouldn't leave a stale range" clamp as
  // clampedTextOverlays above, adapted for TtsOverlay's own shape -- it has
  // no stored endTimeSeconds (see video_math.ts's ttsOverlayEndTimeSeconds),
  // so the DURATION is what gets shortened here instead of an end time.
  const clampedTtsOverlays = selections.ttsOverlays
    .map((overlay) => ({
      ...overlay,
      durationSeconds: Math.min(overlay.durationSeconds, Math.max(totalOriginalDurationSeconds - overlay.startTimeSeconds, 0)),
    }))
    .filter((overlay) => overlay.startTimeSeconds < totalOriginalDurationSeconds && overlay.durationSeconds > 0);

  let trackCursor = 2;
  const nextTrack = () => trackCursor++;

  const videoOverlayElements = buildVideoOverlayElements(clampedVideoOverlays, segments, nextTrack, appMeta, videoOverlaySourceDurations);
  const overlayElements = buildOverlayImageElements(clampedOverlayImages, segments, nextTrack, appMeta);
  const textElements = buildTextElements(clampedTextOverlays, segments, nextTrack);
  const ttsOverlayElements = buildTtsOverlayElements(clampedTtsOverlays, segments, nextTrack, appMeta);
  const transcriptCaptionElements = buildTranscriptCaptionElements(selections.transcriptCaption, videoSegmentPairs, nextTrack());
  const backgroundAudio = buildBackgroundAudioElement(
    backgroundClips,
    totalOutputDurationSeconds,
    nextTrack(),
    appMeta,
    toVolumePercent(backgroundVolume)
  );

  const elements: TemplateElement[] = [
    cropViewport.toMap() as TemplateElement,
    ...videoOverlayElements.map((el) => el.toMap() as TemplateElement),
    ...overlayElements.map((el) => el.toMap() as TemplateElement),
    ...textElements.map((el) => el.toMap() as TemplateElement),
    ...ttsOverlayElements.map((el) => el.toMap() as TemplateElement),
    ...transcriptCaptionElements.map((el) => el.toMap() as TemplateElement),
    ...(backgroundAudio ? [backgroundAudio.toMap() as TemplateElement] : []),
  ];

  return {
    output_format: "mp4",
    width: outputWidth,
    height: outputHeight,
    elements,
    _appMeta: appMeta,
    _totalOutputDurationSeconds: totalOutputDurationSeconds,
  };
}
