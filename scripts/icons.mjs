#!/usr/bin/env node
// Builds every app icon from one hand-drawn vector mark (no generated imagery):
// web/public/favicon.svg plus PNGs rendered with resvg, a real SVG renderer, so the output is reproducible.
//
//   npm run icons
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "web", "public");

// The mark on a 32-unit grid: an arrow rising out of two streams ("upstream").
const MARK = [
  { d: "M8 22c3.2-1.4 4.6-4.4 8-4.4s4.8 3 8 4.4", opacity: 0.55 },
  { d: "M8 16.5c3.2-1.4 4.6-4.4 8-4.4s4.8 3 8 4.4", opacity: 1 },
  { d: "M16 6.5v5.6M13.3 9l2.7-2.7L18.7 9", opacity: 1 },
];

/**
 * shape "rounded": the in-app tile. shape "square": full bleed, for platforms that apply their own mask
 * (iOS home screen, Android maskable icons). The mark's farthest point, stroke caps included, is about 11 units from the centre
 * (35% of the width), inside the maskable safe zone: a circle with a radius of 40% of the width (web.dev/articles/maskable-icon).
 * Small sizes get a thicker stroke so the lines stay crisp at 16 to 32 px.
 */
function svg({ shape = "rounded", scale = 1, stroke = 2.2 } = {}) {
  const offset = 16 - 16 * scale;
  // The mark's ink spans y 6.3 to 23.1, so it is lowered 1.3 units to sit on the optical centre.
  const lift = 1.3 * scale;
  const tile = shape === "rounded" ? `<rect width="32" height="32" rx="9" fill="url(#g)"/>` : `<rect width="32" height="32" fill="url(#g)"/>`;
  const paths = MARK.map(
    (p) => `<path d="${p.d}" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"${p.opacity < 1 ? ` opacity="${p.opacity}"` : ""}/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#2f5bea"/><stop offset="1" stop-color="#11a39c"/></linearGradient></defs>${tile}<g transform="translate(${offset} ${offset + lift}) scale(${scale})">${paths}</g></svg>`;
}

function png(file, size, opts) {
  const r = new Resvg(svg(opts), { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" });
  fs.writeFileSync(path.join(out, file), r.render().asPng());
  console.log(`${file.padEnd(26)} ${size}×${size}`);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "favicon.svg"), svg({ stroke: 2.5 }) + "\n");
console.log("favicon.svg                vector");
png("favicon-32.png", 32, { stroke: 2.6 });
png("apple-touch-icon.png", 180, { shape: "square" });
png("icon-192.png", 192, {});
png("icon-512.png", 512, {});
png("icon-maskable-512.png", 512, { shape: "square", scale: 0.9 });
