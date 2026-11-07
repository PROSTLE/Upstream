// Where each node and path goes, in real pixels of the space available. The diagram is laid out afresh for its width
// instead of being scaled down, so its text stays readable.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  chip?: boolean;
}

export interface Layout {
  shape: "wide" | "vertical";
  width: number;
  height: number;
  boxes: Record<string, Box>;
  /** Keyed "from>to". A token going the other way travels the same path in reverse. */
  paths: Record<string, string>;
  /** Paths drawn for everyone to see. The others exist only for tokens to travel on. */
  visible: string[];
}

const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;
const cx = (b: Box) => b.x + b.w / 2;
const cy = (b: Box) => b.y + b.h / 2;

const across = (a: Box, b: Box) => `M${right(a)},${cy(a)} L${b.x},${cy(b)}`;
const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;

export const MAIN_PATHS = ["funders>pool", "pool>paypal", "paypal>maintainers", "pool>held", "pool>fees", "paypal>unclaimed"];

/** Top row: money in, pool, PayPal, paid. Below: where money waits or goes to fees. */
function wide(width: number): Layout {
  const margin = 6;
  const gap = Math.max(40, Math.min(64, width * 0.06));
  const w = (width - margin * 2 - gap * 3) / 4;
  const h = 108;
  const y0 = 8;
  const y1 = y0 + h + 58;
  const col = (i: number) => margin + i * (w + gap);
  const funders = { x: col(0), y: y0, w, h };
  const pool = { x: col(1), y: y0, w, h };
  const paypal = { x: col(2), y: y0, w, h };
  const maintainers = { x: col(3), y: y0, w, h };
  const held = { x: pool.x - w / 2 - gap / 4, y: y1, w, h };
  const fees = { x: pool.x + w / 2 + gap / 4, y: y1, w, h };
  const unclaimed = { x: maintainers.x, y: y1, w, h };
  const under = bottom(held) + 18;
  return {
    shape: "wide",
    width,
    height: under + 6,
    boxes: { funders, pool, paypal, maintainers, held, fees, unclaimed },
    visible: MAIN_PATHS,
    paths: {
      "funders>pool": across(funders, pool),
      "pool>paypal": across(pool, paypal),
      "paypal>maintainers": across(paypal, maintainers),
      "pool>held": curve(cx(pool) - w * 0.2, bottom(pool), cx(held), held.y),
      "pool>fees": curve(cx(pool) + w * 0.2, bottom(pool), cx(fees), fees.y),
      "paypal>unclaimed": `M${cx(paypal)},${bottom(paypal)} C${cx(paypal)},${cy(unclaimed)} ${cx(paypal) + (unclaimed.x - cx(paypal)) * 0.4},${cy(unclaimed)} ${unclaimed.x},${cy(unclaimed)}`,
      "unclaimed>maintainers": `M${cx(unclaimed)},${unclaimed.y} L${cx(maintainers)},${bottom(maintainers)}`,
      "unclaimed>held": `M${cx(unclaimed)},${bottom(unclaimed)} C${cx(unclaimed)},${under + 14} ${cx(held)},${under + 14} ${cx(held)},${bottom(held)}`,
      "maintainers>held": `M${right(maintainers) - 12},${bottom(maintainers)} C${right(maintainers) - 12},${under + 14} ${cx(held)},${under + 14} ${cx(held)},${bottom(held)}`,
      "paypal>held": curve(paypal.x + w * 0.25, bottom(paypal), right(held) - w * 0.2, held.y),
    },
  };
}

/** Full-width rows on a rail down the left side; tokens slide along the rail. */
function vertical(width: number, rows: string[], rowHeight: (key: string) => number): Layout {
  const railX = 28;
  const x = 62;
  const w = Math.max(width - x - 4, 120);
  const gap = 10;
  const boxes: Record<string, Box> = {};
  let y = 6;
  for (const key of rows) {
    const h = rowHeight(key);
    boxes[key] = { x, y, w, h };
    y += h + gap;
  }
  const rail = (a: string, b: string) => `M${railX},${cy(boxes[a])} L${railX},${cy(boxes[b])}`;
  const paths: Record<string, string> = {};
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) paths[`${rows[i]}>${rows[j]}`] = rail(rows[i], rows[j]);
  return { shape: "vertical", width, height: y, boxes, paths, visible: rows.slice(0, -1).map((k, i) => `${k}>${rows[i + 1]}`) };
}

const VERTICAL_ROWS = ["funders", "pool", "held", "fees", "paypal", "unclaimed", "maintainers"];

/** `narrow` comes from the whole diagram's container: beside the event list, the drawing itself can be under 720 px and still fit its wide shape. */
export function fullLayout(width: number, narrow: boolean): Layout {
  return narrow ? vertical(width, VERTICAL_ROWS, () => 72) : wide(width);
}

/** Overview's short version: tokens run on the top row, and drop into small chips for held, fees and waiting. */
export function compactLayout(width: number): Layout {
  if (width < 470) return vertical(width, VERTICAL_ROWS, (k) => (k === "held" || k === "fees" || k === "unclaimed" ? 38 : 56));
  const margin = 4;
  const gap = Math.max(22, Math.min(40, width * 0.05));
  const w = (width - margin * 2 - gap * 3) / 4;
  const h = 62;
  const y0 = 6;
  const chipH = 30;
  const chipY = y0 + h + 40;
  const chipW = Math.min(w * 0.82, 124);
  const col = (i: number) => margin + i * (w + gap);
  const funders = { x: col(0), y: y0, w, h };
  const pool = { x: col(1), y: y0, w, h };
  const paypal = { x: col(2), y: y0, w, h };
  const maintainers = { x: col(3), y: y0, w, h };
  const held = { x: cx(pool) - chipW - 4, y: chipY, w: chipW, h: chipH, chip: true };
  const fees = { x: cx(pool) + 4, y: chipY, w: chipW, h: chipH, chip: true };
  const unclaimed = { x: right(maintainers) - chipW, y: chipY, w: chipW, h: chipH, chip: true };
  return {
    shape: "wide",
    width,
    height: chipY + chipH + 6,
    boxes: { funders, pool, paypal, maintainers, held, fees, unclaimed },
    visible: MAIN_PATHS,
    paths: {
      "funders>pool": across(funders, pool),
      "pool>paypal": across(pool, paypal),
      "paypal>maintainers": across(paypal, maintainers),
      "pool>held": curve(cx(pool) - w * 0.2, bottom(pool), cx(held), held.y),
      "pool>fees": curve(cx(pool) + w * 0.2, bottom(pool), cx(fees), fees.y),
      "paypal>unclaimed": curve(cx(paypal), bottom(paypal), cx(unclaimed), unclaimed.y),
      "unclaimed>maintainers": `M${cx(unclaimed)},${unclaimed.y} L${cx(unclaimed)},${bottom(maintainers)}`,
      "unclaimed>held": `M${unclaimed.x},${cy(unclaimed)} L${right(fees)},${cy(fees)}`,
      "maintainers>held": curve(cx(maintainers), bottom(maintainers), cx(fees), fees.y),
      "paypal>held": curve(paypal.x + w * 0.2, bottom(paypal), right(held) - 8, held.y),
    },
  };
}

/** One payout: pool, the PayPal batch, then a row per payment. */
export function batchLayout(width: number, itemKeys: string[]): Layout {
  if (width < 720) return vertical(width, ["pool", "paypal", ...itemKeys], (k) => (k === "pool" ? 58 : k === "paypal" ? 66 : 54));
  const gap = 56;
  const poolW = 128;
  const batchW = 196;
  const rowH = 46;
  const rowGap = 8;
  const rowsH = Math.max(itemKeys.length, 1) * (rowH + rowGap) - rowGap;
  const h = 76;
  const height = Math.max(rowsH, h) + 12;
  const midY = height / 2;
  const pool = { x: 4, y: midY - h / 2, w: poolW, h };
  const paypal = { x: pool.x + poolW + gap, y: midY - h / 2, w: batchW, h };
  const rowX = paypal.x + batchW + gap;
  const rowW = width - rowX - 4;
  const boxes: Record<string, Box> = { pool, paypal };
  const paths: Record<string, string> = { "pool>paypal": across(pool, paypal) };
  const visible = ["pool>paypal"];
  itemKeys.forEach((key, i) => {
    const b = { x: rowX, y: 6 + i * (rowH + rowGap) + (height - 12 - rowsH) / 2, w: rowW, h: rowH };
    boxes[key] = b;
    const k = `paypal>${key}`;
    paths[k] = `M${right(paypal)},${cy(paypal)} C${right(paypal) + gap / 2},${cy(paypal)} ${b.x - gap / 2},${cy(b)} ${b.x},${cy(b)}`;
    visible.push(k);
  });
  return { shape: "wide", width, height, boxes, paths, visible };
}
