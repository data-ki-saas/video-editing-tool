"use client";

/**
 * The "Label" popup (the UserActions "Label" button -- formerly "Text").
 * Pick a label from the two-column catalog (lib/video/labelTemplates.ts),
 * type straight into it -- the selected tile turns into the label itself with
 * an input per part, and each part grows or shrinks with its text -- drag it
 * into place on a live frame preview, and choose how long it shows on a time
 * bar at the bottom.
 *
 * Labels all live on ONE track row (LabelTrack.tsx) and never overlap, so the
 * time bar only lets this label move within the free stretch around where it
 * started (computeLabelGapBounds) -- other labels show up as grey blocks it
 * can't cross. Once placed, it can be dragged to a different gap on the track
 * itself.
 *
 * Opened fresh for a new label (editingOverlay null) or pre-filled by
 * clicking a label's segment on the track. Legacy free-text captions still
 * open TextOverlayDialog (see ActionArea.tsx) -- this dialog only ever deals
 * in `label:` templates.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { HEADLINE_STROKE_EM } from "@/lib/video/headlineTemplates";
import { TextOverlayCanvas } from "./TextOverlayCanvas";
import { OverlayRectOverlay } from "./OverlayRectOverlay";
import { CropRectOverlay } from "./CropRectOverlay";
import { formatTimeRange, type CropRect, type TextOverlay } from "@/lib/video/video_math";
import {
  DEFAULT_LABEL_DURATION_SECONDS,
  LABEL_PAD_X_EM,
  LABEL_PAD_Y_EM,
  LABEL_LINE_EM,
  LABEL_ROUND_RADIUS_EM,
  LABEL_SPECS,
  MIN_LABEL_DURATION_SECONDS,
  computeLabelGapBounds,
  decodeLabelText,
  defaultLabelRect,
  encodeLabelText,
  findFreeLabelSlot,
  getLabelSpec,
  labelTemplateId,
  type LabelSpec,
} from "@/lib/video/labelTemplates";

const PREVIEW_PROGRESS = 0.6;
const PREVIEW_LOOP_SECONDS = 3;
const MAX_PART_LENGTH = 40;

/** One label drawn in CSS -- the picker's own view of a LabelSpec (the canvas
 * view, drawLabel, is what actually plays; both read the same em-based
 * metrics). With `editable` each part is an input that sizes itself to its
 * text, so typing reshapes the label right where it sits. */
function LabelView({
  spec,
  values,
  editable = false,
  onChange,
  fontSizePx = 15,
}: {
  spec: LabelSpec;
  values: string[];
  editable?: boolean;
  onChange?: (partIndex: number, value: string) => void;
  fontSizePx?: number;
}) {
  // Nothing typed yet -> show the catalog's example text; otherwise show only
  // what was typed (a blank part is hidden in the final label, so the
  // read-only views hide it too -- the editable view always keeps every
  // part's input so there's somewhere to type).
  const nothingTyped = values.every((value) => value.trim() === "");
  const visible = spec.parts
    .map((partSpec, index) => ({ partSpec, index, value: values[index] ?? "" }))
    .filter((entry) => editable || nothingTyped || entry.value.trim() !== "");

  const stacked = spec.layout === "stacked" && visible.length > 1;
  const radius = spec.corners === "full" ? "9999px" : spec.corners === "round" ? `${LABEL_ROUND_RADIUS_EM}em` : "0";
  // Headline specs are bare text: no backing, bigger type, outline/glow.
  const headline = spec.headline;

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: stacked ? "column" : "row",
        alignItems: "stretch",
        fontSize: headline ? fontSizePx * 1.5 : fontSizePx,
        borderRadius: headline ? 0 : radius,
        overflow: headline ? "visible" : "hidden",
        boxShadow: headline ? "none" : "0 2px 6px rgba(0,0,0,0.35)",
        maxWidth: "100%",
      }}
    >
      {visible.map(({ partSpec, index, value }) => {
        const partStyle: CSSProperties = headline
          ? {
              color: partSpec.fg,
              fontWeight: 700,
              lineHeight: LABEL_LINE_EM,
              textAlign: "center",
              whiteSpace: "pre",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              ...(headline.stroke
                ? { WebkitTextStroke: `${HEADLINE_STROKE_EM}em ${headline.stroke}`, paintOrder: "stroke fill" }
                : {}),
              textShadow: headline.glow
                ? `0 0 0.3em ${headline.glow}, 0 0 0.6em ${headline.glow}`
                : "0 0.04em 0.08em rgba(0,0,0,0.45)",
            }
          : {
              background: partSpec.bg,
              color: partSpec.fg,
              fontSize: `${partSpec.scale}em`,
              fontWeight: partSpec.bold ? 700 : 400,
              lineHeight: LABEL_LINE_EM,
              padding: `${LABEL_PAD_Y_EM}em ${LABEL_PAD_X_EM}em`,
              textAlign: "center",
              whiteSpace: "pre",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            };
        const shownText = value.trim() === "" && (nothingTyped || editable) ? partSpec.placeholder : value;

        if (!editable) {
          return (
            <div key={index} style={partStyle}>
              {shownText}
            </div>
          );
        }
        return (
          <div key={index} style={partStyle}>
            {/* Hidden mirror span gives the input its width: the grid cell
                is as wide as the longer of the two, so the part hugs its text. */}
            <span style={{ display: "inline-grid" }}>
              <span aria-hidden style={{ gridArea: "1 / 1", visibility: "hidden", whiteSpace: "pre", minWidth: "2ch" }}>
                {value || partSpec.placeholder}
              </span>
              <input
                value={value}
                maxLength={MAX_PART_LENGTH}
                placeholder={partSpec.placeholder}
                onChange={(e) => onChange?.(index, e.target.value)}
                aria-label={partSpec.placeholder}
                className="placeholder:opacity-50"
                style={{
                  gridArea: "1 / 1",
                  width: "100%",
                  minWidth: 0,
                  font: "inherit",
                  color: "inherit",
                  background: "transparent",
                  textAlign: "center",
                  border: 0,
                  padding: 0,
                  outline: "none",
                }}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The bottom time bar -- the whole reel, with this label as a draggable
 * block (drag the body to move it, the edges to lengthen/shorten it). */
function LabelTimeBar({
  totalSeconds,
  startSeconds,
  endSeconds,
  bounds,
  otherRanges,
  playheadSeconds,
  onChange,
}: {
  totalSeconds: number;
  startSeconds: number;
  endSeconds: number;
  bounds: { min: number; max: number };
  otherRanges: { start: number; end: number }[];
  playheadSeconds: number;
  onChange: (start: number, end: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  function startDrag(e: React.PointerEvent, mode: "move" | "start" | "end") {
    e.preventDefault();
    e.stopPropagation();
    const bar = barRef.current;
    if (!bar || totalSeconds <= 0) return;
    const barWidth = bar.getBoundingClientRect().width;
    const originX = e.clientX;
    const originStart = startSeconds;
    const originEnd = endSeconds;

    function compute(clientX: number): [number, number] {
      const dx = ((clientX - originX) / barWidth) * totalSeconds;
      if (mode === "move") {
        const length = originEnd - originStart;
        const start = Math.min(Math.max(originStart + dx, bounds.min), bounds.max - length);
        return [start, start + length];
      }
      if (mode === "start") {
        return [Math.min(Math.max(originStart + dx, bounds.min), originEnd - MIN_LABEL_DURATION_SECONDS), originEnd];
      }
      return [originStart, Math.max(Math.min(originEnd + dx, bounds.max), originStart + MIN_LABEL_DURATION_SECONDS)];
    }

    function handleMove(moveEvent: PointerEvent) {
      onChange(...compute(moveEvent.clientX));
    }
    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const pct = (seconds: number) => (totalSeconds > 0 ? (seconds / totalSeconds) * 100 : 0);

  return (
    <div>
      <div ref={barRef} className="relative h-8 w-full select-none rounded-md bg-background">
        {/* The stretch this label is free to move within. */}
        <div
          className="absolute inset-y-0 rounded-md bg-accent/10"
          style={{ left: `${pct(bounds.min)}%`, width: `${pct(bounds.max) - pct(bounds.min)}%` }}
        />
        {otherRanges.map((range, index) => (
          <div
            key={index}
            title="Another label"
            className="absolute inset-y-1 rounded-sm bg-muted/40"
            style={{ left: `${pct(range.start)}%`, width: `${pct(range.end) - pct(range.start)}%` }}
          />
        ))}
        <div
          className="absolute inset-y-0 w-px bg-red-500"
          title="Playhead"
          style={{ left: `${pct(Math.min(playheadSeconds, totalSeconds))}%` }}
        />
        <div
          onPointerDown={(e) => startDrag(e, "move")}
          title="Drag to move"
          className="absolute inset-y-1 cursor-grab touch-none rounded-sm border border-accent bg-accent/60 active:cursor-grabbing"
          style={{ left: `${pct(startSeconds)}%`, width: `${pct(endSeconds) - pct(startSeconds)}%` }}
        >
          <div
            onPointerDown={(e) => startDrag(e, "start")}
            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize touch-none rounded-l-sm bg-accent"
          />
          <div
            onPointerDown={(e) => startDrag(e, "end")}
            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize touch-none rounded-r-sm bg-accent"
          />
        </div>
      </div>
      <p className="mt-1 text-[11px] text-muted">
        Shown {formatTimeRange(startSeconds, endSeconds)} ({(endSeconds - startSeconds).toFixed(1)}s) -- drag the bar to
        move it, drag its ends to change how long it shows.
      </p>
    </div>
  );
}

export function LabelDialog({
  editingOverlay,
  editingIndex,
  textOverlays,
  previewFrameUrl,
  frameAspectRatio,
  cropRect,
  currentTimeSeconds,
  videoDurationSeconds,
  onSave,
  onDelete,
  onClose,
}: {
  /** The label being edited, or null to add a new one. */
  editingOverlay: TextOverlay | null;
  editingIndex: number | null;
  /** Every text overlay on the reel (labels are the `label:` ones) -- needed
   * to keep this label from overlapping the others on the single track. */
  textOverlays: TextOverlay[];
  previewFrameUrl: string | null;
  frameAspectRatio: number | null;
  /** The reel's own output crop, drawn read-only as a placement guide --
   * same role as in TextOverlayDialog. */
  cropRect: CropRect | null;
  currentTimeSeconds: number;
  videoDurationSeconds: number;
  onSave: (text: string, templateId: string, rect: CropRect, startTimeSeconds: number, endTimeSeconds: number) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const editingSpec = editingOverlay ? getLabelSpec(editingOverlay.templateId) : undefined;
  const [spec, setSpec] = useState<LabelSpec>(editingSpec ?? LABEL_SPECS[0]);
  const [values, setValues] = useState<string[]>(() =>
    editingOverlay && editingSpec ? decodeLabelText(editingOverlay.text, 2) : ["", ""]
  );
  const [rect, setRect] = useState<CropRect>(editingOverlay?.rect ?? defaultLabelRect(spec));
  const rectTouched = useRef(editingOverlay !== null);

  // The starting time range, and the free gap around it that bounds every
  // later drag on the time bar. Computed once at open.
  const initial = useMemo(() => {
    if (editingOverlay) return { start: editingOverlay.startTimeSeconds, end: editingOverlay.endTimeSeconds };
    return findFreeLabelSlot(textOverlays, currentTimeSeconds, DEFAULT_LABEL_DURATION_SECONDS, videoDurationSeconds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a snapshot at open; later edits must not re-seed it
  }, []);
  const [range, setRange] = useState<{ start: number; end: number } | null>(initial);
  const bounds = useMemo(
    () =>
      initial
        ? computeLabelGapBounds(textOverlays, editingIndex, initial.start, initial.end, videoDurationSeconds)
        : { min: 0, max: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same snapshot-at-open reasoning as `initial`
    [initial]
  );
  const otherRanges = useMemo(
    () =>
      textOverlays
        .filter((overlay, index) => index !== editingIndex && getLabelSpec(overlay.templateId))
        .map((overlay) => ({ start: overlay.startTimeSeconds, end: overlay.endTimeSeconds })),
    [textOverlays, editingIndex]
  );

  function selectSpec(next: LabelSpec) {
    setSpec(next);
    // A stacked label is about twice as tall as a one-line one -- re-seed
    // the box's default size when switching between the two families, unless
    // the creator has already placed it by hand.
    if (!rectTouched.current) setRect(defaultLabelRect(next));
  }

  function updateRect(next: CropRect) {
    rectTouched.current = true;
    setRect(next);
  }

  function setValue(partIndex: number, value: string) {
    setValues((prev) => prev.map((existing, index) => (index === partIndex ? value : existing)));
  }

  // Headline styles are animated, so their on-frame preview loops through the
  // label's own 0..1 progress; the pill/capsule labels just hold a still.
  const [loopProgress, setLoopProgress] = useState(PREVIEW_PROGRESS);
  const animated = spec.headline !== undefined;
  useEffect(() => {
    if (!animated) return;
    let frame = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      setLoopProgress((((now - startedAt) / 1000) % PREVIEW_LOOP_SECONDS) / PREVIEW_LOOP_SECONDS);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animated]);

  const activeValues = values.slice(0, spec.parts.length);
  const hasText = activeValues.some((value) => value.trim() !== "");
  const canSave = hasText && range !== null && range.end - range.start >= MIN_LABEL_DURATION_SECONDS - 1e-6;

  // On-frame preview text: placeholders only until something is typed, then
  // exactly what will be saved (a blank part drops out, same as playback).
  const previewText = encodeLabelText(hasText ? activeValues : spec.parts.map((p) => p.placeholder));

  function handleSave() {
    if (!canSave || !range) return;
    onSave(encodeLabelText(activeValues), labelTemplateId(spec.id), rect, range.start, range.end);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editingOverlay ? "Edit label" : "Add label"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{editingOverlay ? "Edit label" : "Add label"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
          {/* Left: the real frame, with the label's box draggable on it. */}
          <div className="flex flex-col gap-1.5 sm:w-5/12">
            <div
              className="relative w-full overflow-hidden rounded-md bg-black"
              style={frameAspectRatio ? { aspectRatio: `${frameAspectRatio}` } : { minHeight: "12rem" }}
            >
              {previewFrameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset
                <img src={previewFrameUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : (
                <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                  No frame preview yet -- add a video first
                </p>
              )}
              {cropRect && <CropRectOverlay cropRect={cropRect} />}
              <OverlayRectOverlay
                rect={rect}
                onChange={updateRect}
                onCommit={updateRect}
                renderInner={
                  <TextOverlayCanvas
                    text={previewText}
                    templateId={labelTemplateId(spec.id)}
                    progress={animated ? loopProgress : PREVIEW_PROGRESS}
                    className="h-full w-full"
                  />
                }
              />
            </div>
            <p className="text-[11px] text-muted">
              Drag to position. The box&apos;s height sets the label&apos;s size; its width is the most it can grow.
            </p>
          </div>

          {/* Right: the catalog, two columns. The picked tile is editable. */}
          <div className="flex min-h-0 flex-1 flex-col sm:w-7/12">
            <p className="mb-2 text-[11px] text-muted">
              Pick a label, then type right in it. Leave a part empty to hide it.
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="grid grid-cols-2 gap-2">
                {LABEL_SPECS.map((option) => {
                  const selected = option.id === spec.id;
                  const tileClassName =
                    "flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 overflow-hidden rounded-md border-2 bg-neutral-700 bg-cover bg-center px-2 py-2.5 " +
                    (selected ? "border-accent" : "border-transparent hover:border-border");
                  // Each tile sits on the frame under the playhead (the red
                  // line on the time bar), so a label is judged against the
                  // footage it will actually appear over.
                  const tileStyle: CSSProperties | undefined = previewFrameUrl
                    ? { backgroundImage: `url("${previewFrameUrl}")` }
                    : undefined;
                  const caption = (
                    <span className="rounded-sm bg-black/60 px-1.5 text-[10px] text-neutral-100">{option.name}</span>
                  );
                  return selected ? (
                    <div key={option.id} className={tileClassName} style={tileStyle}>
                      <LabelView spec={option} values={values} editable onChange={setValue} />
                      {caption}
                    </div>
                  ) : (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => selectSpec(option)}
                      className={tileClassName}
                      style={tileStyle}
                    >
                      <LabelView spec={option} values={values} />
                      {caption}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom: how long it's shown. */}
        <div className="mt-3 border-t border-border pt-3">
          {range ? (
            <LabelTimeBar
              totalSeconds={videoDurationSeconds}
              startSeconds={range.start}
              endSeconds={range.end}
              bounds={bounds}
              otherRanges={otherRanges}
              playheadSeconds={currentTimeSeconds}
              onChange={(start, end) => setRange({ start, end })}
            />
          ) : (
            <p className="text-xs text-red-600">
              {videoDurationSeconds <= 0
                ? "Add a video first -- a label needs a reel to sit on."
                : "No room left on the label track. Shorten or remove another label to make space."}
            </p>
          )}

          <div className="mt-3 flex items-center justify-end gap-2">
            {editingOverlay && onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="mr-auto rounded-md border border-border px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-background"
              >
                Remove
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              {editingOverlay ? "Save" : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
