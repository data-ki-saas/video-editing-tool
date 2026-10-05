"use client";

/**
 * "Vectors" tab of PropsDialog -- live search over the Iconify API
 * (https://iconify.design/docs/api/; public, CORS-open, no key) restricted to
 * sets under permissive licences (MIT / ISC / Apache-2.0), then per-vector
 * customization (fill, stroke colour + width, flip, rotate) before placing.
 *
 * Search returns "prefix:name" ids; the artwork itself comes from a second
 * batched call per set. Third-party SVG markup is only ever shown through
 * <img src="data:..."> (scripts never run there) and rasterized to a
 * transparent PNG on placement, so it travels the same upload -> image-overlay
 * path as every other prop and renders identically in preview and export.
 */
import { useEffect, useMemo, useState } from "react";

const ICONIFY_API = "https://api.iconify.design";
const ALLOWED_SETS = ["lucide", "tabler", "ph", "heroicons", "bi", "ri", "carbon", "iconoir"];
const PAGE_SIZE = 64;
const RASTER_SIZE = 512;
const DEFAULT_QUERY = "star";
const MAX_STROKE_WIDTH = 8;
const COLOR_SWATCHES = ["#ffffff", "#000000", "#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];

interface VectorArt {
  body: string;
  width: number;
  height: number;
}

interface VectorStyle {
  fill: string;
  stroke: string;
  // null = leave the artwork's own stroke alone (and add no outline to solid icons).
  strokeWidth: number | null;
  flipX: boolean;
  flipY: boolean;
  rotation: number;
}

const DEFAULT_STYLE: VectorStyle = { fill: "#ffffff", stroke: "#ffffff", strokeWidth: null, flipX: false, flipY: false, rotation: 0 };

const artCache = new Map<string, VectorArt>();

async function searchIconIds(query: string, start: number, signal: AbortSignal): Promise<{ ids: string[]; total: number }> {
  const url = new URL(`${ICONIFY_API}/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("start", String(start));
  url.searchParams.set("palette", "false"); // single-colour artwork only, so recolouring works
  url.searchParams.set("prefixes", ALLOWED_SETS.join(","));
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Vector search failed");
  const data = (await response.json()) as { icons?: string[]; total?: number };
  return { ids: data.icons ?? [], total: data.total ?? 0 };
}

async function loadArt(ids: string[], signal: AbortSignal) {
  const missing = new Map<string, string[]>();
  for (const id of ids) {
    if (artCache.has(id)) continue;
    const [prefix, name] = id.split(":");
    if (!prefix || !name) continue;
    missing.set(prefix, [...(missing.get(prefix) ?? []), name]);
  }
  await Promise.all(
    [...missing].map(async ([prefix, names]) => {
      const response = await fetch(`${ICONIFY_API}/${prefix}.json?icons=${names.map(encodeURIComponent).join(",")}`, { signal });
      if (!response.ok) throw new Error("Failed to load vectors");
      const data = (await response.json()) as {
        width?: number;
        height?: number;
        icons?: Record<string, { body: string; width?: number; height?: number }>;
      };
      for (const [name, icon] of Object.entries(data.icons ?? {})) {
        artCache.set(`${prefix}:${name}`, {
          body: icon.body,
          width: icon.width ?? data.width ?? 16,
          height: icon.height ?? data.height ?? 16,
        });
      }
    })
  );
}

function isLineArt(art: VectorArt): boolean {
  return art.body.includes('stroke="currentColor"');
}

/** The customized vector as a standalone, square SVG document. */
function buildSvg(art: VectorArt, style: VectorStyle, size = RASTER_SIZE): string {
  const line = isLineArt(art);
  let body = art.body
    .replace(/fill="currentColor"/g, `fill="${style.fill}"`)
    .replace(/stroke="currentColor"/g, `stroke="${style.stroke}"`)
    .replace(/currentColor/g, style.fill);
  const outlineSolid = !line && style.strokeWidth !== null && style.strokeWidth > 0;
  if (line && style.strokeWidth !== null) {
    body = body.replace(/stroke-width="[^"]*"/g, `stroke-width="${style.strokeWidth}"`);
  }
  // Solid artwork gets an outline as a root-level stroke; room for it so it isn't clipped.
  const pad = outlineSolid ? (style.strokeWidth ?? 0) * (Math.max(art.width, art.height) / 24) : 0;
  const side = Math.max(art.width, art.height) + pad * 2;
  const rootStroke = outlineSolid
    ? ` stroke="${style.stroke}" stroke-width="${(style.strokeWidth ?? 0) * (Math.max(art.width, art.height) / 24)}" stroke-linejoin="round"`
    : "";
  const transform = `translate(${side / 2} ${side / 2}) rotate(${style.rotation}) scale(${style.flipX ? -1 : 1} ${style.flipY ? -1 : 1}) translate(${-art.width / 2} ${-art.height / 2})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${side} ${side}" fill="${style.fill}"${rootStroke}><g transform="${transform}">${body}</g></svg>`;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Rasterizes an SVG document to a transparent PNG file. */
export async function rasterizeSvgToPng(svg: string, filename: string): Promise<File> {
  const img = new Image();
  img.src = svgDataUrl(svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = RASTER_SIZE;
  canvas.height = RASTER_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not draw this vector");
  ctx.drawImage(img, 0, 0, RASTER_SIZE, RASTER_SIZE);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not draw this vector");
  return new File([blob], filename, { type: "image/png" });
}

// A light checkerboard, so white/transparent artwork stays visible.
const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundColor: "#e5e5e5",
  backgroundImage:
    "linear-gradient(45deg, #cfcfcf 25%, transparent 25%, transparent 75%, #cfcfcf 75%), linear-gradient(45deg, #cfcfcf 25%, transparent 25%, transparent 75%, #cfcfcf 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
};

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-10 shrink-0 text-[11px] text-muted">{label}</span>
      {COLOR_SWATCHES.map((swatch) => (
        <button
          key={swatch}
          type="button"
          onClick={() => onChange(swatch)}
          aria-label={`${label} ${swatch}`}
          style={{ backgroundColor: swatch }}
          className={`h-5 w-5 rounded-full border ${value === swatch ? "ring-2 ring-accent ring-offset-1" : "border-border"}`}
        />
      ))}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Custom ${label.toLowerCase()} colour`}
        className="h-6 w-6 cursor-pointer rounded border border-border bg-transparent p-0"
      />
    </div>
  );
}

export function VectorsTab({
  placingKey,
  onPlace,
}: {
  // Id of the vector currently being uploaded (disables the grid), or null.
  placingKey: string | null;
  onPlace: (file: File, key: string) => void;
}) {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [debouncedQuery, setDebouncedQuery] = useState(DEFAULT_QUERY);
  // "Show more" asks for the page after the one already loaded for this query;
  // a different query always starts again at 0.
  const [more, setMore] = useState({ query: "", start: 0 });
  const [result, setResult] = useState<{ key: string; ids: string[]; total: number; error: string | null } | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [style, setStyle] = useState<VectorStyle>(DEFAULT_STYLE);

  const pageStart = more.query === debouncedQuery ? more.start : 0;
  const requestKey = `${debouncedQuery}|${pageStart}`;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery) return;
    const controller = new AbortController();
    searchIconIds(debouncedQuery, pageStart, controller.signal)
      .then(async (found) => {
        await loadArt(found.ids, controller.signal);
        setResult((previous) => ({
          key: requestKey,
          ids: pageStart === 0 ? found.ids : [...(previous?.ids ?? []), ...found.ids.filter((id) => !previous?.ids.includes(id))],
          total: found.total,
          error: null,
        }));
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          key: requestKey,
          ids: previous?.ids ?? [],
          total: previous?.total ?? 0,
          error: err instanceof Error ? err.message : "Vector search failed",
        }));
      });
    return () => controller.abort();
  }, [debouncedQuery, pageStart, requestKey]);

  const ids = useMemo(() => (debouncedQuery ? (result?.ids ?? []) : []), [debouncedQuery, result]);
  const total = result?.total ?? 0;
  const isLoading = debouncedQuery !== "" && result?.key !== requestKey;
  const error = placeError ?? (debouncedQuery ? (result?.error ?? null) : null);
  const visibleIds = useMemo(() => ids.filter((id) => artCache.has(id)), [ids]);
  const update = (patch: Partial<VectorStyle>) => setStyle((previous) => ({ ...previous, ...patch }));

  function handlePlace(id: string) {
    const art = artCache.get(id);
    if (!art || placingKey) return;
    setPlaceError(null);
    rasterizeSvgToPng(buildSvg(art, style), `vector-${id.replace(":", "-")}.png`)
      .then((file) => onPlace(file, id))
      .catch((err) => setPlaceError(err instanceof Error ? err.message : "Could not add this vector"));
  }

  return (
    <>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search vectors (e.g. arrow, camera, heart, crown)"
        className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
      />

      <div className="mb-2 flex flex-col gap-1.5 rounded-md border border-border p-2">
        <ColorRow label="Fill" value={style.fill} onChange={(fill) => update({ fill })} />
        <ColorRow label="Stroke" value={style.stroke} onChange={(stroke) => update({ stroke })} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            Stroke width
            <input
              type="range"
              min={0}
              max={MAX_STROKE_WIDTH}
              step={0.5}
              value={style.strokeWidth ?? 0}
              onChange={(e) => update({ strokeWidth: Number(e.target.value) })}
              className="w-28"
            />
            <span className="w-8 text-foreground">{style.strokeWidth === null ? "Auto" : style.strokeWidth}</span>
            {style.strokeWidth !== null && (
              <button type="button" onClick={() => update({ strokeWidth: null })} className="underline hover:text-foreground">
                Auto
              </button>
            )}
          </label>
          <div className="flex items-center gap-1 text-[11px]">
            <button type="button" onClick={() => update({ flipX: !style.flipX })} aria-pressed={style.flipX} className={`rounded border px-1.5 py-0.5 ${style.flipX ? "border-accent text-foreground" : "border-border text-muted"}`}>
              Flip ↔
            </button>
            <button type="button" onClick={() => update({ flipY: !style.flipY })} aria-pressed={style.flipY} className={`rounded border px-1.5 py-0.5 ${style.flipY ? "border-accent text-foreground" : "border-border text-muted"}`}>
              Flip ↕
            </button>
            <button type="button" onClick={() => update({ rotation: (style.rotation + 90) % 360 })} className="rounded border border-border px-1.5 py-0.5 text-muted hover:text-foreground">
              Rotate ↻ {style.rotation}°
            </button>
            <button type="button" onClick={() => setStyle(DEFAULT_STYLE)} className="px-1 text-muted underline hover:text-foreground">
              Reset
            </button>
          </div>
        </div>
        <p className="text-[10px] text-muted">
          Line-style icons use the stroke colour; solid icons use the fill (a stroke width adds an outline). Colours are fixed
          once placed -- delete and re-add to change them.
        </p>
      </div>

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      <div className="flex-1 overflow-y-auto">
        {visibleIds.length === 0 ? (
          <p className="text-center text-xs text-muted">{isLoading ? "Searching…" : debouncedQuery ? "No vectors match." : "Type to search."}</p>
        ) : (
          <>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
              {visibleIds.map((id) => {
                const art = artCache.get(id) as VectorArt;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => handlePlace(id)}
                    disabled={placingKey !== null}
                    title={id.replace(":", " / ")}
                    className="flex aspect-square items-center justify-center rounded-md border border-border p-2 hover:border-accent disabled:opacity-60"
                    style={CHECKERBOARD_STYLE}
                  >
                    {placingKey === id ? (
                      <span className="text-[10px] text-black">…</span>
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element -- a data: URL built from third-party SVG; <img> keeps any script inert
                      <img src={svgDataUrl(buildSvg(art, style, 96))} alt={id} className="h-full w-full object-contain drop-shadow-[0_0_1px_rgba(0,0,0,0.6)]" />
                    )}
                  </button>
                );
              })}
            </div>
            {ids.length < total && (
              <button
                type="button"
                disabled={isLoading}
                onClick={() => setMore({ query: debouncedQuery, start: ids.length })}
                className="mx-auto mt-3 block rounded-md border border-border px-3 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
              >
                {isLoading ? "Loading…" : `Show more (${total - ids.length} left)`}
              </button>
            )}
          </>
        )}
        <p className="mt-3 text-center text-[10px] text-muted">Vectors via Iconify -- Lucide, Tabler, Phosphor, Heroicons, Bootstrap, Remix, Carbon, Iconoir (MIT / ISC / Apache-2.0).</p>
      </div>
    </>
  );
}
