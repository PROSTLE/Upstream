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

// The mark on a 32-unit grid: a salmon leaping out of the current, swimming upstream to where the work came from.
// Three flat colours and no gradients. web/src/ui.tsx draws the same shapes for the in-app logo.
export const COLORS = { ink: "#14233f", salmon: "#f2795b", water: "#f4efe3" };
const FISH = [
  // Body, drawn level and facing right, then turned 35 degrees to leap up and to the right.
  `<path d="M26.6 16C22.8 11.7 15.2 11.6 10.6 16c4.6 4.4 12.2 4.3 16 0Z" fill="${COLORS.salmon}"/>`,
  // Forked tail.
  `<path d="M11.4 16 5.6 11.9l1.9 4.1-1.9 4.1Z" fill="${COLORS.salmon}"/>`,
  `<circle cx="23.1" cy="15.2" r=".95" fill="${COLORS.ink}"/>`,
].join("");
const CURRENT = "M5.5 26.4c1.6-1.3 3.3-1.3 4.9 0s3.3 1.3 4.9 0 3.3-1.3 4.9 0 3.3 1.3 4.9 0";

/**
 * shape "rounded": the in-app tile. shape "square": full bleed, for platforms that apply their own mask
 * (iOS home screen, Android maskable icons). The current's outer ends are the mark's farthest points, about 15.8 units
 * from the centre, so the maskable icon scales the mark to 0.78 to keep it inside the safe zone: a circle with a radius
 * of 40% of the width (web.dev/articles/maskable-icon). Small sizes get a thicker current so it stays crisp at 16 to 32 px.
 */
function svg({ shape = "rounded", scale = 1, current = 2.1 } = {}) {
  const offset = 16 - 16 * scale;
  const tile = `<rect width="32" height="32"${shape === "rounded" ? ` rx="8"` : ""} fill="${COLORS.ink}"/>`;
  const mark = `<g transform="translate(.6 -2.4) rotate(-35 16 16)">${FISH}</g><path d="${CURRENT}" fill="none" stroke="${COLORS.water}" stroke-width="${current}" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${tile}<g transform="translate(${offset} ${offset}) scale(${scale})">${mark}</g></svg>`;
}

function png(file, size, opts) {
  const r = new Resvg(svg(opts), { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" });
  fs.writeFileSync(path.join(out, file), r.render().asPng());
  console.log(`${file.padEnd(26)} ${size}×${size}`);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "favicon.svg"), svg({ current: 2.4 }) + "\n");
console.log("favicon.svg                vector");
png("favicon-32.png", 32, { current: 2.6 });
png("apple-touch-icon.png", 180, { shape: "square", scale: 0.9 });
png("icon-192.png", 192, {});
png("icon-512.png", 512, {});
png("icon-maskable-512.png", 512, { shape: "square", scale: 0.78 });
// The README's header and the GitHub social preview use the large rounded mark.
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "logo.svg"), svg() + "\n");
console.log("docs/logo.svg              vector");
