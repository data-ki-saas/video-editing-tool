"use client";

/**
 * The auto-caption analog of TextOverlayCanvas.tsx -- a small <canvas>
 * that draws one transcript-caption style via
 * lib/video/transcriptCaptionTemplates.ts's renderer. Unlike
 * TextOverlayCanvas, there's no real text/progress to drive it -- every
 * renderer draws the same fixed placeholder at a fixed static frame, since
 * the real transcript doesn't exist until render time (see
 * TranscriptCaption's own doc comment in video_math.ts).
 */
import { useEffect, useRef } from "react";
import { getTranscriptCaptionRenderer } from "@/lib/video/transcriptCaptionTemplates";

const PREVIEW_TEXT = "Your Words Here";
const PREVIEW_PROGRESS = 0.6;

export function TranscriptCaptionCanvas({ templateId, className }: { templateId: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const renderer = getTranscriptCaptionRenderer(templateId);
    renderer?.({
      ctx,
      text: PREVIEW_TEXT,
      rectPx: { x: 0, y: 0, width: canvas.width, height: canvas.height },
      progress: PREVIEW_PROGRESS,
    });
  }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw() is freshly defined every render and always closes over the latest templateId
  }, []);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw() is freshly defined every render and always closes over the latest templateId
  }, [templateId]);

  return <canvas ref={canvasRef} className={className} />;
}
