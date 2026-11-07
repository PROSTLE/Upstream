#!/usr/bin/env node
// Builds every app icon from one hand-drawn vector mark (no generated imagery):
// web/public/favicon.svg, docs/logo.svg for the README, and PNGs rendered with resvg, a real SVG renderer, so the output is reproducible.
//
//   npm run icons
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "web", "public");

// The mark on a 32-unit grid: an arrow rising out of two streams ("upstream").
// web/src/ui.tsx draws the same shapes for the in-app logo.
const MARK = [
  { d: "M7.6 23.4C10.6 22.2 12.4 19.2 16 19.2s5.4 3 8.4 4.2", opacity: 0.5 },
  { d: "M7.6 17.6C10.6 16.4 12.4 13.4 16 13.4s5.4 3 8.4 4.2", opacity: 1 },
  { d: "M16 13.4V6.6M12.7 9.7 16 6.4l3.3 3.3", opacity: 1 },
];

/**
 * shape "rounded": the in-app tile. shape "square": full bleed, for platforms that apply their own mask
 * (iOS home screen, Android maskable icons). The wave ends are the mark's farthest points, about 12.4 units from the centre
 * with their round caps, so the maskable icon scales the mark to 0.9 to stay inside the safe zone: a circle with a radius of
 * 40% of the width (web.dev/articles/maskable-icon). Small sizes get a thicker stroke so the lines stay crisp at 16 to 32 px.
 */
function svg({ shape = "rounded", scale = 1, stroke = 2.4 } = {}) {
  const offset = 16 - 16 * scale;
  const corner = shape === "rounded" ? ` rx="9"` : "";
  const defs =
    `<defs>` +
    // Blue to teal, corner to corner, through a slightly deeper middle so the colour stays rich at small sizes.
    `<linearGradient id="g" x1="2" y1="30" x2="30" y2="2" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2b4fe0"/><stop offset=".55" stop-color="#1f7fc4"/><stop offset="1" stop-color="#12a89e"/></linearGradient>` +
    // A very soft light from the top edge.
    `<linearGradient id="l" x1="16" y1="0" x2="16" y2="14" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `</defs>`;
  const tile = `<rect width="32" height="32"${corner} fill="url(#g)"/><rect width="32" height="32"${corner} fill="url(#l)"/>`;
  const paths = MARK.map(
    (p) => `<path d="${p.d}" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"${p.opacity < 1 ? ` stroke-opacity="${p.opacity}"` : ""}/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${defs}${tile}<g transform="translate(${offset} ${offset}) scale(${scale})">${paths}</g></svg>`;
}

function png(file, size, opts) {
  const r = new Resvg(svg(opts), { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" });
  fs.writeFileSync(path.join(out, file), r.render().asPng());
  console.log(`${file.padEnd(26)} ${size}×${size}`);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "favicon.svg"), svg({ stroke: 2.6 }) + "\n");
console.log("favicon.svg                vector");
png("favicon-32.png", 32, { stroke: 2.7 });
png("apple-touch-icon.png", 180, { shape: "square", scale: 0.92 });
png("icon-192.png", 192, {});
png("icon-512.png", 512, {});
png("icon-maskable-512.png", 512, { shape: "square", scale: 0.9 });
// The README's header uses the large rounded mark.
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "logo.svg"), svg() + "\n");
console.log("docs/logo.svg              vector");
