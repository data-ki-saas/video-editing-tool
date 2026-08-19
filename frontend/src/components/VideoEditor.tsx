"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Preview } from "@creatomate/preview";
import { listAssets, uploadAsset, type Asset } from "@/lib/api";

const REEL_WIDTH = 1080;
const REEL_HEIGHT = 1920;
const ACCEPTED_FILE_TYPES = "video/mp4,image/jpeg,image/png";

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isMobile, setIsMobile] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [template, setTemplate] = useState<TemplateState>(createEmptyReelTemplate);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const videoAssets = assets.filter((asset) => asset.kind === "video");
  const imageAssets = assets.filter((asset) => asset.kind === "image");

  useEffect(() => {
    // navigator is undefined during SSR, so this can't be a lazy useState
    // initializer without risking a hydration mismatch -- it has to run
    // client-side only, after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMobile(isMobileDevice());
  }, []);

  const refreshAssets = useCallback(async () => {
    try {
      const data = await listAssets(projectId);
      setAssets(data);
      setAssetsError(null);
    } catch (err) {
      setAssetsError(err instanceof Error ? err.message : "Failed to load assets");
    }
  }, [projectId]);

  useEffect(() => {
    // refreshAssets() itself only calls setState after its await -- this
    // fetch-on-mount/projectId-change pattern is what the effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAssets();
  }, [refreshAssets]);

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

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets the same file be re-selected later
    if (!file) return;

    setIsUploading(true);
    setUploadError(null);
    try {
      const asset = await uploadAsset(projectId, file);
      setAssets((prev) => [asset, ...prev]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
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

  /** Placeholder: a real implementation would let the user pick which of
   * their uploaded images to overlay. This adds a fixed placeholder overlay
   * in the top-right corner using the first uploaded image, just to
   * demonstrate the state shape. */
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
          source: imageAssets[0]?.url ?? null,
        },
      ],
    });
  }

  const buttonClass =
    "rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium " +
    "hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  if (isMobile) {
    return (
      <div role="alert" className="m-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-900">
        The video editor requires a desktop browser — the Creatomate Preview
        SDK needs hardware video decoding that mobile browsers don&apos;t
        reliably support. Please switch to a desktop device to continue
        editing.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className={buttonClass} onClick={handleTrim} disabled={!isReady || !selectedAssetId}>
          Trim
        </button>
        <button className={buttonClass} onClick={handleAddArtificialBackground} disabled={!isReady}>
          Add Artificial Background
        </button>
        <button
          className={buttonClass}
          onClick={handleOverlayImage}
          disabled={!isReady || imageAssets.length === 0}
        >
          Overlay Image
        </button>

        <span className="mx-1 h-5 w-px bg-neutral-300" aria-hidden="true" />

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          className="hidden"
          onChange={handleFileSelected}
          disabled={isUploading}
        />
        <button
          className={
            "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 " +
            "disabled:cursor-not-allowed disabled:opacity-40"
          }
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
        >
          {isUploading ? "Uploading…" : "Upload video or image"}
        </button>
      </div>

      {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}
      {assetsError && <p className="text-sm text-red-600">Couldn&apos;t load assets: {assetsError}</p>}

      <div
        ref={containerRef}
        className="w-full max-w-[405px] overflow-hidden rounded-md border border-neutral-300 bg-neutral-900"
        style={{ aspectRatio: "9 / 16" }}
      />

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-700">Your videos</h2>
        {videoAssets.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No videos yet — click &quot;Upload video or image&quot; above to get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {videoAssets.map((asset) => (
              <li key={asset.id}>
                <button
                  className={
                    "w-full rounded-md border px-3 py-1.5 text-left text-sm hover:bg-neutral-100 " +
                    (asset.id === selectedAssetId
                      ? "border-neutral-900 font-medium"
                      : "border-neutral-300")
                  }
                  onClick={() => handleSelectAsset(asset)}
                >
                  {asset.filename}
                  {asset.id === selectedAssetId ? " (selected)" : ""}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
