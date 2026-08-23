"use client";

/**
 * A small <canvas> that draws one text overlay via its chosen template's
 * renderer (lib/video/textTemplates.ts) -- the SAME renderer CanvasPlayer
 * uses for final playback, so a live preview here (inside FrameStrip's
 * active tile, or inside TextOverlayDialog) is pixel-consistent with what
 * actually plays, not a separate CSS approximation.
 *
 * Internal canvas resolution tracks the element's own rendered pixel size
 * (via ResizeObserver) rather than a fixed resolution, so text stays crisp
 * whether this is shown small (a FrameStrip tile) or large (the dialog's
 * own preview).
 */
import { useEffect, useRef } from "react";
import { getTextTemplateRenderer } from "@/lib/video/textTemplates";

export function TextOverlayCanvas({
  text,
  templateId,
  progress,
  className,
}: {
  text: string;
  // A plain string, not the narrower TextTemplateId union -- callers
  // often pass a persisted TextOverlay.templateId straight through (see
  // getTextTemplateRenderer's own comment on why that's untyped JSON, not
  // guaranteed to still be a known id).
  templateId: string;
  progress: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const renderer = getTextTemplateRenderer(templateId);
    renderer?.({ ctx, text, rectPx: { x: 0, y: 0, width: canvas.width, height: canvas.height }, progress });
  }

  // Keeps the canvas's own pixel resolution matched to its rendered CSS
  // size, so text stays crisp at whatever size this is shown -- a tiny
  // FrameStrip tile or a much larger dialog preview.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
      draw();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw() is freshly defined every render and always closes over the latest text/template/progress
  }, []);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw() is freshly defined every render and always closes over the latest text/template/progress
  }, [text, templateId, progress]);

  return <canvas ref={canvasRef} className={className} />;
}
