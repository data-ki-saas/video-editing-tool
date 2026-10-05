// Regenerates src/lib/materialIcons.json from @material-design-icons/svg
// (Apache-2.0): { "<icon_name>": "<inner svg markup of the 24x24 filled glyph>" }.
// Run: node scripts/build-material-icons.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join("node_modules", "@material-design-icons", "svg", "filled");
const icons = {};
for (const file of readdirSync(dir).sort()) {
  if (!file.endsWith(".svg")) continue;
  const svg = readFileSync(join(dir, file), "utf8");
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  icons[file.slice(0, -4)] = inner;
}
writeFileSync(join("src", "lib", "materialIcons.json"), JSON.stringify(icons));
console.log(`${Object.keys(icons).length} icons`);
