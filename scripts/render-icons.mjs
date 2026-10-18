// Renders the app icons from apps/web/app/icon.svg so every size matches the one source mark.
//   node scripts/render-icons.mjs   -> apple-icon.png (180), favicon.ico (16/32/48), public/kaizen-mark.png (512)
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const svg = readFileSync("apps/web/app/icon.svg", "utf8");
const png = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

writeFileSync("apps/web/app/apple-icon.png", png(180));
writeFileSync("apps/web/public/kaizen-mark.png", png(512));

// ICO with embedded PNGs (supported by every current browser).
const sizes = [16, 32, 48];
const images = sizes.map(png);
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s, e);
  header.writeUInt8(s, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(images[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
writeFileSync("apps/web/app/favicon.ico", Buffer.concat([header, ...images]));
console.log("icons: apple-icon.png 180, favicon.ico 16/32/48, public/kaizen-mark.png 512");
