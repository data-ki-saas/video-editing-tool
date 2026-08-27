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
  Keyframe,
  TextTypewriter,
  TextAppearWordByWord,
} from "creatomate";
import type { EditSelectionsSnapshot, Timeline, TemplateElement, AppMetaEntry } from "@/lib/projects";
import {
  buildRenderSegments,
  mapSourceRangeToOutputRanges,
  totalSequenceDuration,
  computeEffectiveCropRect,
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
 * arrays when a ZoomEffect overlaps this segment) for one Video element. */
function buildCropProperties(segment: RenderSegment, baseCropRect: CropRect | null, zoomEffects: ZoomEffect[]) {
  const segStart = segment.sourceStartSeconds;
  const segEnd = segment.sourceStartSeconds + segment.durationSeconds;
  const base = baseCropRect ?? FULL_FRAME_CROP_RECT;

  const overlaps = zoomEffects.some((effect) => effect.endTimeSeconds > segStart && effect.startTimeSeconds < segEnd);
  if (!overlaps) {
    return cropRectToVideoTransform(computeEffectiveCropRect(base, zoomEffects, segStart));
  }

  const breakpoints = findCropBreakpoints(zoomEffects, segStart, segEnd);
  const width: Keyframe<string>[] = [];
  const height: Keyframe<string>[] = [];
  const x: Keyframe<string>[] = [];
  const y: Keyframe<string>[] = [];

  for (const t of breakpoints) {
    const crop = computeEffectiveCropRect(base, zoomEffects, t);
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

/** One Video or Image element per RenderSegment, each with its own
 * crop/zoom keyframes, all on track 1 of their shared parent (sequenced
 * back-to-back, same convention as the README's multi-clip example). An
 * image segment gets no trimStart/trimDuration (meaningless for a still
 * image -- it has no timeline of its own to trim into), but otherwise
 * reuses buildCropProperties verbatim: Image's x/y/width/height/xAnchor/
 * yAnchor are the same ValueOrKeyframes-typed properties Video's are
 * (both extend the SDK's shared ElementBase/ElementProperties -- verified
 * directly against node_modules/creatomate/src/elements/{Image,
 * ElementBase}.ts), so the exact same keyframed crop transform applies to
 * either element type unchanged. */
function buildMediaSegments(
  segments: RenderSegment[],
  baseCropRect: CropRect | null,
  zoomEffects: ZoomEffect[],
  appMeta: Record<string, AppMetaEntry>,
  mainVolumePercent: string,
  cutawayFilterByEntryId: Map<string, FilterPresetId | null>
): (Video | Image)[] {
  return segments.map((segment) => {
    const crop = buildCropProperties(segment, baseCropRect, zoomEffects);
    const filter = getCreatomateFilterProperties(
      segment.entryId ? (cutawayFilterByEntryId.get(segment.entryId) ?? null) : null
    );

    if (segment.kind === "image") {
      const id = nextId("clip");
      appMeta[id] = { role: "clip", assetId: segment.assetId };
      return new Image({
        id,
        track: 1,
        time: segment.outputStartSeconds,
        duration: segment.durationSeconds,
        fit: "fill",
        xAnchor: "0%",
        yAnchor: "0%",
        ...crop,
        ...filter,
        // Overwritten server-side by resolveAssetSources (api/render/route.ts)
        // from _appMeta[id].assetId -- never a real playable URL by itself.
        source: "",
      });
    }

    const id = nextId("clip");
    appMeta[id] = { role: "clip", assetId: segment.assetId };
    return new Video({
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
      ...crop,
      ...filter,
      // Overwritten server-side by resolveAssetSources (api/render/route.ts)
      // from _appMeta[id].assetId -- never a real playable URL by itself.
      source: "",
    });
  });
}

/** The flip/mirror wrapper -- one composition spanning the WHOLE output
 * timeline (flip toggles are authored globally, not per-segment, and can
 * land mid-segment), center-anchored so xScale/yScale mirror in place.
 * Holds every video segment as its own children. Returns a plain
 * Composition (no crop keyframes of its own) when there's nothing to
 * flip on either axis, to avoid emitting pointless static 100% keyframes. */
function buildFlipWrapper(
  mediaSegments: (Video | Image)[],
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
 * audio, see CanvasPlayer.tsx's computeMainAudioGainBreakpoints) is not
 * reflected here at all -- every overlay's own `Video` element below plays
 * with Creatomate's own default audio behavior, and the base track's
 * volume is never ducked. Reproducing this server-side would need per-
 * element `volume` (for the overlay's own share) plus keyframed volume
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
          x: pct(overlayRect.x + overlayRect.width / 2),
          y: pct(overlayRect.y + overlayRect.height / 2),
          width: pct(overlayRect.width),
          height: pct(overlayRect.height),
          xAnchor: "50%",
          yAnchor: "50%",
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
          xAnchor: "0%",
          yAnchor: "0%",
          ...rectProperties(overlay.rect),
          ...buildTextTemplateStyle(overlay.templateId, durationSeconds),
        })
      );
    }
  }
  return elements;
}

/** Per-template style + entrance animation. DIY scale-in entrances
 * (Bold Pop, Bounce In) use property keyframes directly on xScale/yScale
 * rather than Creatomate's canned Bounce/TextScale animation classes,
 * which describe a different motion (a repeated bounce, or a scale with
 * no controllable start value) than our one-shot pop -- see the plan's
 * mapping table for why each template's animation was chosen. */
function buildTextTemplateStyle(templateId: string, durationSeconds: number): Record<string, unknown> {
  switch (templateId) {
    case "bold-pop":
      return {
        fontWeight: 700,
        fillColor: "#ffffff",
        strokeColor: "#000000",
        strokeWidth: "2%",
        xAnchor: "50%",
        yAnchor: "50%",
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
        xAnchor: "50%",
        yAnchor: "50%",
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
 * synthesis itself) rather than ASR transcription of the base video. */
function buildTtsOverlayElements(
  ttsOverlays: EditSelectionsSnapshot["ttsOverlays"],
  segments: RenderSegment[],
  nextTrack: () => number,
  appMeta: Record<string, AppMetaEntry>
): (Audio | Text)[] {
  const elements: (Audio | Text)[] = [];
  for (const overlay of ttsOverlays) {
    const audioTrack = nextTrack();
    const captionTrack = nextTrack();
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
            xAnchor: "0%",
            yAnchor: "0%",
            ...rectProperties(overlay.rect),
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
  const segments = buildRenderSegments(sequenceClips, selections.trimRanges);
  const totalOutputDurationSeconds = segments.reduce((sum, s) => sum + s.durationSeconds, 0);

  const cutawayFilterByEntryId = new Map(selections.sequenceClips.map((entry) => [entry.id, entry.colorFilterId ?? null]));
  const mediaSegments = buildMediaSegments(
    segments,
    selections.cropRect,
    selections.zoomEffects,
    appMeta,
    toVolumePercent(mainAudioVolume),
    cutawayFilterByEntryId
  );
  const videoSegmentPairs = segments
    .map((segment, index) => ({ segment, element: mediaSegments[index] }))
    .filter((pair): pair is { segment: RenderSegment; element: Video } => pair.segment.kind === "video");
  const flipWrapper = buildFlipWrapper(
    mediaSegments,
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
  };
}
