// Builds public/peeps-coloured/manifest.json (and copies the loose face/head parts
// into public/peeps-coloured/parts/) from the Open Peeps "Flat Assets" download.
// Run once after unpacking the pack:
//   node scripts/build-peeps-plus.mjs "<path to 'Separate Atoms' folder>"
// Poses are expected at public/peeps-coloured/poses/{standing,sitting}/ and ready-made
// figures at public/peeps-coloured/templates/{Bust,Standing,Sitting,covid-19}/.
//
// The pack's loose parts are drawn 4.2x larger than its templates; PeepsPlusTab
// scales them back down and places them at the offsets the templates use (all
// templates of one stance share the same offsets, so any head fits any pose).
// bbox = [x, y, w, h] of the visible pixels in the part's own coordinates.
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const atoms = process.argv[2];
if (!atoms) throw new Error("usage: node scripts/build-peeps-plus.mjs <Separate Atoms folder>");
const root = join("public", "peeps-coloured");

const slug = (name) => name.toLowerCase().replace(/\.svg$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const label = (name) => name.replace(/\.svg$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

async function bboxOf(file) {
  const { data, info } = await sharp(file, { density: 72 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

async function parts(sourceDir, destDir, urlDir, withBbox) {
  mkdirSync(destDir, { recursive: true });
  const out = [];
  for (const file of readdirSync(sourceDir).filter((f) => f.endsWith(".svg")).sort()) {
    const id = slug(file);
    // Files already in place (poses) keep their names; copied parts get slug names.
    const inPlace = sourceDir === destDir;
    const name = inPlace ? file : `${id}.svg`;
    const dest = join(destDir, name);
    if (!inPlace) copyFileSync(join(sourceDir, file), dest);
    out.push({ id, label: label(file), file: `${urlDir}/${name}`, ...(withBbox ? { bbox: await bboxOf(dest) } : {}) });
  }
  return out;
}

const manifest = {
  scale: 1 / 4.2,
  // Offsets (template units): pose and head from the figure's origin; face, facial hair
  // and accessory from the head's origin.
  layouts: {
    standing: { pose: [-28.74, 150.26], head: [95.95, 42.66], face: [37.76, 44.08], facialHair: [29.21, 80.11], accessory: [11.16, 57.12] },
    sitting: { pose: [-20.31, 159.5], head: [86.51, 45.07], face: [39.87, 46.57], facialHair: [30.84, 84.64], accessory: [11.79, 60.35] },
  },
  poses: {
    standing: await parts(join(root, "poses", "standing"), join(root, "poses", "standing"), "poses/standing", true),
    sitting: await parts(join(root, "poses", "sitting"), join(root, "poses", "sitting"), "poses/sitting", true),
  },
  heads: await parts(join(atoms, "head"), join(root, "parts", "head"), "parts/head", true),
  faces: await parts(join(atoms, "face"), join(root, "parts", "face"), "parts/face", false),
  facialHair: await parts(join(atoms, "facial-hair"), join(root, "parts", "facial-hair"), "parts/facial-hair", false),
  accessories: await parts(join(atoms, "accessories"), join(root, "parts", "accessories"), "parts/accessories", false),
  templates: {},
};
for (const [key, dir] of [["bust", "Bust"], ["standing", "Standing"], ["sitting", "Sitting"], ["masks", "covid-19"]]) {
  manifest.templates[key] = readdirSync(join(root, "templates", dir))
    .filter((f) => f.endsWith(".svg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => `templates/${dir}/${f}`);
}
writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
console.log(Object.entries(manifest.templates).map(([k, v]) => `${k}: ${v.length}`).join(", "));
