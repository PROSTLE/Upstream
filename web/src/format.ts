export function money(minor: number | null | undefined, currency: string): string {
  if (minor == null) return "—";
  if (minor === 0) minor = 0; // normalise -0 so zero never renders as "-0.00"
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: digits }).format(minor / 10 ** digits);
}

export function moneyStr(value: string | null | undefined, currency: string): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(Number(value));
}

export function pct(x: number | null | undefined, digits = 0): string {
  if (x == null || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function duration(a: string | null | undefined, b: string | null | undefined): string {
  if (!a || !b) return "—";
  const m = Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60000);
  return m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`;
}

export const shortId = (id: string | null | undefined, n = 8) => (id ? (id.length > n + 2 ? `${id.slice(0, n)}…` : id) : "—");

/** "1 session", "3 sessions": the count and the word, pluralised in English. */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
