// Face workbench: builds a self-contained HTML page (frontend/face-workbench.html)
// that runs the REAL src/lib/video/avatar/placeholderAtlas.ts in the browser, so
// what you see is exactly what the app would draw. Tune the drawing code (or
// just the palette via the page's controls), re-run, refresh. When a face looks
// right, hit "Copy palette" and paste it as a new buildSeedSkin(...) entry in
// src/lib/video/avatar/library.ts.
//
//   node scripts/face-workbench.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/lib/video/avatar/placeholderAtlas.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Face Workbench</title>
<style>
  :root { --bg:#f5f3f0; --fg:#1d1b19; --card:#fff; --line:#ddd8d2; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17161a; --fg:#ecebe8; --card:#232227; --line:#3a3840; } }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:14px system-ui,sans-serif; }
  h1 { font-size:18px; margin:0 0 12px; }
  .layout { display:flex; flex-wrap:wrap; gap:16px; align-items:flex-start; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; }
  .controls { display:grid; grid-template-columns:auto 1fr; gap:8px 10px; align-items:center; min-width:230px; }
  .controls input[type=color] { width:100%; height:28px; border:1px solid var(--line); padding:0; background:none; }
  .row { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0; }
  button, select { font:inherit; padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); cursor:pointer; }
  button.on { background:var(--fg); color:var(--bg); }
  canvas { image-rendering:auto; max-width:100%; }
  #stage { background:repeating-conic-gradient(#8884 0 25%, #0000 0 50%) 0 0/16px 16px; border-radius:8px; }
  pre { margin:8px 0 0; font-size:12px; white-space:pre-wrap; }
</style></head><body>
<h1>Face Workbench</h1>
<div class="layout">
  <div class="card">
    <div id="label" style="font-weight:600;margin-bottom:6px"></div>
    <canvas id="stage"></canvas>
    <div class="row" id="moods"></div>
    <div class="row" id="eyes"></div>
    <div class="row" id="brows"></div>
    <div class="row" id="mouth"></div>
  </div>
  <div class="card">
    <div class="controls" id="controls"></div>
    <div class="row">
      <button id="copy">Copy palette</button>
      <button id="png">Download atlas PNG</button>
    </div>
    <pre id="out"></pre>
  </div>
  <div class="card"><div style="margin-bottom:6px">Full atlas</div><canvas id="atlas"></canvas></div>
</div>
<script>
const { buildPlaceholderAtlas } = (() => {
  const exports = {};
${js}
  return exports;
})();

const fields = [
  ["skinTone", "Skin", "#e0a981"], ["hairColor", "Hair", "#3b1f14"],
  ["eyeColor", "Eyes", "#4f6f52"], ["lipColor", "Lips", "#b8465a"],
  ["browColor", "Brows", "#2e1a12"], ["shirtColor", "Shirt", "#2f7f86"],
  ["pantsColor", "Pants", "#22344a"],
];
const state = { faceStyle: "detailed", stubble: false, eyes: "eyeOpen", brows: "neutral", mouth: "closed" };
const DEFAULTS = {
  detailed: { skinTone: "#e0a981", hairColor: "#3b1f14", eyeColor: "#4f6f52", lipColor: "#b8465a", browColor: "#2e1a12", shirtColor: "#2f7f86" },
  masculine: { skinTone: "#c99468", hairColor: "#1f1612", eyeColor: "#4a3426", lipColor: "#a8605a", browColor: "#1f1612", shirtColor: "#3f5f8a" },
};
const inputs = {};
const palette = Object.fromEntries(fields.map(([k, , v]) => [k, v]));
const $ = (id) => document.getElementById(id);

const ctrl = $("controls");
const styleSel = document.createElement("select");
styleSel.innerHTML = '<option value="detailed">detailed (feminine)</option><option value="masculine">detailed (masculine)</option><option value="classic">classic (Maya)</option>';
styleSel.onchange = () => {
  state.faceStyle = styleSel.value;
  const d = DEFAULTS[state.faceStyle];
  if (d) for (const [k, v] of Object.entries(d)) { palette[k] = v; inputs[k].value = v; }
  render();
};
ctrl.append(Object.assign(document.createElement("label"), { textContent: "Style" }), styleSel);
for (const [k, label] of fields) {
  const l = Object.assign(document.createElement("label"), { textContent: label });
  const i = Object.assign(document.createElement("input"), { type: "color", value: palette[k] });
  i.oninput = () => { palette[k] = i.value; render(); };
  inputs[k] = i;
  ctrl.append(l, i);
}
const stub = Object.assign(document.createElement("input"), { type: "checkbox" });
stub.onchange = () => { state.stubble = stub.checked; render(); };
ctrl.append(Object.assign(document.createElement("label"), { textContent: "Stubble" }), stub);
function picker(id, key, opts) {
  for (const o of opts) {
    const b = Object.assign(document.createElement("button"), { textContent: o });
    b.onclick = () => { state[key] = o; render(); };
    b.dataset.v = o; $(id).append(b);
  }
}
picker("eyes", "eyes", ["eyeOpen", "eyeClosed"]);
picker("brows", "brows", ["neutral", "angry", "happy", "sad"]);
picker("mouth", "mouth", ["closed", "open", "laughOpen", "smile"]);
for (const [label, brows, mouth] of [["Neutral", "neutral", "closed"], ["Happy (brows+smile)", "happy", "smile"], ["Laugh (brows+laugh)", "happy", "laughOpen"]]) {
  const b = Object.assign(document.createElement("button"), { textContent: label });
  b.onclick = () => { state.brows = brows; state.mouth = mouth; render(); };
  $("moods").append(b);
}

const initial = location.hash.slice(1);
if (DEFAULTS[initial]) {
  state.faceStyle = initial;
  styleSel.value = initial;
  for (const [k, v] of Object.entries(DEFAULTS[initial])) { palette[k] = v; inputs[k].value = v; }
}

function load(url) { return new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = url; }); }

async function render() {
  const classic = state.faceStyle === "classic";
  $("label").textContent = "Style: " + styleSel.options[styleSel.selectedIndex].text;
  const p = { skinTone: palette.skinTone, shirtColor: palette.shirtColor, pantsColor: palette.pantsColor, hairColor: palette.hairColor };
  if (!classic) Object.assign(p, { faceStyle: "detailed", ...(state.faceStyle === "masculine" ? { masculine: true, ...(state.stubble ? { stubble: true } : {}) } : {}), eyeColor: palette.eyeColor, lipColor: palette.lipColor, browColor: palette.browColor });
  const a = buildPlaceholderAtlas(p);
  const img = await load(a.dataUrl);
  const R = a.partRects;
  const atlas = $("atlas"); atlas.width = img.width; atlas.height = img.height;
  atlas.getContext("2d").drawImage(img, 0, 0);

  // Assemble a bust the way the renderer does: each part's rect lands at (joint - pivot).
  // Head-local coords, chin joint at (70,128). Pivots mirror library.ts PLACEHOLDER_SKIN_PARTS.
  const S = 3, W = 140 + 20, H = 270;
  const c = $("stage"); c.width = W * S; c.height = H * S;
  const x = c.getContext("2d"); x.scale(S, S);
  const put = (rect, jx, jy, px, py) => x.drawImage(img, rect.sx, rect.sy, rect.sWidth, rect.sHeight, jx - px + 10, jy - py, rect.sWidth, rect.sHeight);
  put(R.neck, 70, 140, 32, 24);
  put(R.torso, 70, 140, 60, 8);
  put(R.head, 70, 128, 70, 128);
  put(R[state.eyes], 70, 128, 30, 76);
  put(R[state.brows], 70, 128, 30, 88);
  put(R[state.mouth], 70, 128, 25, 40);

  for (const b of document.querySelectorAll("#eyes button,#brows button,#mouth button")) b.classList.toggle("on", Object.values(state).includes(b.dataset.v));
  const out = classic ? { ...p } : p;
  $("out").textContent = JSON.stringify(out, null, 2);
}
$("copy").onclick = () => navigator.clipboard.writeText($("out").textContent);
$("png").onclick = () => { const a = document.createElement("a"); a.download = "atlas.png"; a.href = $("atlas").toDataURL(); a.click(); };
render();
</script></body></html>`;

const out = join(root, "face-workbench.html");
writeFileSync(out, html);
console.log("wrote " + out);
