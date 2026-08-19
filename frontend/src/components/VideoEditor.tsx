"use client";

import { useEffect, useRef, useState } from "react";
import { Preview } from "@creatomate/preview";
import { listAssets, type Asset } from "@/lib/api";

const REEL_WIDTH = 1080;
const REEL_HEIGHT = 1920;

type TemplateElement = Record<string, unknown> & { id: string };

type TemplateState = {
  output_format: "mp4";
  width: number;
  height: number;
  elements: TemplateElement[];
};

function createEmptyReelTemplate(): TemplateState {
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
  };
}

function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function VideoEditor({ projectId }: { projectId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<Preview | null>(null);

  const [isMobile, setIsMobile] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [template, setTemplate] = useState<TemplateState>(createEmptyReelTemplate);

  useEffect(() => {
    // navigator is undefined during SSR, so this can't be a lazy useState
    // initializer without risking a hydration mismatch -- it has to run
    // client-side only, after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMobile(isMobileDevice());
  }, []);

  useEffect(() => {
    listAssets(projectId)
      .then((data) => setAssets(data.filter((asset) => asset.kind === "video")))
      .catch((err) => console.error("[VideoEditor] failed to load assets", err));
  }, [projectId]);

  // Initializes the Creatomate Preview plugin inside `containerRef` once the
  // device check above has settled -- the SDK needs real desktop-class video
  // decoding, so it's never constructed on a mobile browser (see the
  // early-return render below).
  useEffect(() => {
    if (isMobile || !containerRef.current) return;

    const token = process.env.NEXT_PUBLIC_CREATOMATE_PUBLIC_TOKEN;
    if (!token) {
      console.error("[VideoEditor] NEXT_PUBLIC_CREATOMATE_PUBLIC_TOKEN is not set");
      return;
    }

    const preview = new Preview(containerRef.current, "player", token);
    preview.onReady = () => {
      setIsReady(true);
      void preview.setSource(template);
    };
    previewRef.current = preview;

    return () => {
      setIsReady(false);
      previewRef.current = null;
      preview.dispose();
    };
    // Only re-initializes when the mobile check settles -- `template` is
    // intentionally excluded, it's pushed via setSource() on demand instead
    // of by tearing down and recreating the whole plugin instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  async function pushTemplate(next: TemplateState) {
    setTemplate(next);
    if (previewRef.current && isReady) {
      await previewRef.current.setSource(next);
    }
  }

  function handleSelectAsset(asset: Asset) {
    setSelectedAssetId(asset.id);
    void pushTemplate({
      ...template,
      elements: template.elements.map((el) =>
        el.id === "main-video" ? { ...el, source: asset.url } : el
      ),
    });
  }

  /** Placeholder: a real trim tool would read in/out points from a timeline
   * scrubber. This just sets a fixed 5-second clip starting at 0 on the main
   * video element, to show the JSON shape setSource() expects. */
  function handleTrim() {
    void pushTemplate({
      ...template,
      elements: template.elements.map((el) =>
        el.id === "main-video" ? { ...el, trim_start: 0, trim_duration: 5 } : el
      ),
    });
  }

  /** Placeholder: a real implementation would call a background removal/
   * generation service and feed its output URL in as the video's matte or a
   * new background element. This just inserts a solid-color shape behind the
   * video on track 0. */
  function handleAddArtificialBackground() {
    if (template.elements.some((el) => el.id === "artificial-background")) return;
    void pushTemplate({
      ...template,
      elements: [
        {
          id: "artificial-background",
          name: "Artificial Background",
          type: "shape",
          track: 0,
          width: "100%",
          height: "100%",
          x: "50%",
          y: "50%",
          fill_color: "#111111",
        },
        ...template.elements,
      ],
    });
  }

  /** Placeholder: a real implementation would let the user pick one of their
   * uploaded images (same `assets` list, filtered to kind === "image") to
   * overlay. This adds a fixed placeholder overlay in the top-right corner
   * using the first available asset, just to demonstrate the state shape. */
  function handleOverlayImage() {
    if (template.elements.some((el) => el.id === "image-overlay")) return;
    void pushTemplate({
      ...template,
      elements: [
        ...template.elements,
        {
          id: "image-overlay",
          name: "Image Overlay",
          type: "image",
          track: 2,
          width: "30%",
          height: "30%",
          x: "80%",
          y: "20%",
          source: assets[0]?.url ?? null,
        },
      ],
    });
  }

  if (isMobile) {
    return (
      <div role="alert">
        The video editor requires a desktop browser — the Creatomate Preview
        SDK needs hardware video decoding that mobile browsers don&apos;t
        reliably support. Please switch to a desktop device to continue
        editing.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={handleTrim} disabled={!isReady || !selectedAssetId}>
          Trim
        </button>
        <button onClick={handleAddArtificialBackground} disabled={!isReady}>
          Add Artificial Background
        </button>
        <button onClick={handleOverlayImage} disabled={!isReady || assets.length === 0}>
          Overlay Image
        </button>
      </div>

      <div ref={containerRef} style={{ width: "100%", maxWidth: 405, aspectRatio: "9 / 16" }} />

      <ul>
        {assets.map((asset) => (
          <li key={asset.id}>
            <button onClick={() => handleSelectAsset(asset)}>
              {asset.filename}
              {asset.id === selectedAssetId ? " (selected)" : ""}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
