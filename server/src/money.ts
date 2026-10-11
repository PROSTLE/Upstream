// Money is stored as integer minor units. Fraction digits come from the
// platform's ISO-4217 data (Intl), not from a table in this repo.

export function minorDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
}

export function toMinor(value: string | number, currency: string): number {
  const digits = minorDigits(currency);
  const s = typeof value === "number" ? value.toFixed(digits) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount "${value}"`);
  const negative = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  if (frac.length > digits && /[1-9]/.test(frac.slice(digits))) {
    throw new Error(`Amount "${value}" has more precision than ${currency} allows`);
  }
  const minor = Number(whole) * 10 ** digits + Number((frac + "0".repeat(digits)).slice(0, digits) || "0");
  return negative ? -minor : minor;
}

export function fromMinor(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** digits);
  const frac = String(abs % 10 ** digits).padStart(digits, "0");
  return `${negative ? "-" : ""}${whole}${digits > 0 ? "." + frac : ""}`;
}

/**
 * Split `total` minor units across weights with the largest-remainder method,
 * so the parts always sum exactly to `total`.
 */
export function splitByWeights(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}
