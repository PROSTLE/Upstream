// Moves money tokens along the diagram's paths. Imperative on purpose: one requestAnimationFrame loop working on refs,
// no React state per frame, and the loop only runs while something is moving.

const SVG = "http://www.w3.org/2000/svg";
const TRAVEL_MS = 1400;
const STAGGER_MS = 140;
const MAX_MOVING = 12;
const COUNT_MS = 600;
const TOKEN_H = 22;
const CHAR_W = 7;

/** cubic-bezier(x1, y1, x2, y2), solved for x by bisection. */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}
const ease = bezier(0.45, 0, 0.25, 1);
const easeOut = bezier(0, 0, 0.2, 1);

export interface TokenSpec {
  path: SVGPathElement;
  /** Travels the path from its end back to its start. */
  reverse: boolean;
  text: string;
  amountMinor: number;
  tone: string;
  /** Upstream's own hold, not money PayPal moved. */
  outline: boolean;
  onLaunch?: () => void;
  onArrive?: () => void;
}

interface Moving extends TokenSpec {
  el: SVGGElement;
  length: number;
  startedAt: number;
}

interface Counter {
  set: (value: number) => void;
  from: number;
  to: number;
  startedAt: number;
}

export class TokenEngine {
  private layer: SVGGElement;
  private formatMerged: (count: number, minor: number) => string;
  private moving: Moving[] = [];
  private queue: TokenSpec[] = [];
  private merged: { specs: TokenSpec[]; minor: number } | null = null;
  private counters = new Map<object, Counter>();
  private frameId = 0;
  private nextLaunchAt = 0;
  private onIdle: () => void;
  /** 4 means four times as fast. Used by Replay. */
  speed = 1;

  constructor(layer: SVGGElement, onIdle: () => void, formatMerged: (count: number, minor: number) => string) {
    this.layer = layer;
    this.onIdle = onIdle;
    this.formatMerged = formatMerged;
  }

  get busy() {
    return this.moving.length > 0 || this.queue.length > 0 || this.merged !== null;
  }

  enqueue(spec: TokenSpec) {
    // Never more than twelve at once; whatever doesn't fit travels together as one chip.
    if (this.moving.length + this.queue.length >= MAX_MOVING) {
      const m = (this.merged ??= { specs: [], minor: 0 });
      m.specs.push(spec);
      m.minor += spec.amountMinor;
    } else this.queue.push(spec);
    this.run();
  }

  /** Moves a displayed number to `to` over 600 ms. The key is whatever identifies the number. */
  count(key: object, set: (value: number) => void, from: number, to: number) {
    if (from === to) {
      set(to);
      this.counters.delete(key);
      return;
    }
    this.counters.set(key, { set, from, to, startedAt: performance.now() });
    this.run();
  }

  /** Stops everything and removes every token. Arrivals that were still due run now, so no number stays behind. */
  clear() {
    for (const m of this.moving) {
      m.el.remove();
      m.onArrive?.();
    }
    for (const s of [...this.queue, ...(this.merged?.specs ?? [])]) {
      s.onLaunch?.();
      s.onArrive?.();
    }
    this.moving = [];
    this.queue = [];
    this.merged = null;
    for (const c of this.counters.values()) c.set(c.to);
    this.counters.clear();
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }

  private run() {
    if (!this.frameId) this.frameId = requestAnimationFrame(this.frame);
  }

  private launch(spec: TokenSpec, now: number) {
    const el = document.createElementNS(SVG, "g");
    el.setAttribute("class", `mf-token ${spec.tone}${spec.outline ? " outline" : ""}`);
    el.setAttribute("aria-hidden", "true");
    const width = spec.text.length * CHAR_W + 16;
    const rect = document.createElementNS(SVG, "rect");
    rect.setAttribute("x", String(-width / 2));
    rect.setAttribute("y", String(-TOKEN_H / 2));
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", String(TOKEN_H));
    rect.setAttribute("rx", String(TOKEN_H / 2));
    const text = document.createElementNS(SVG, "text");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("y", "4");
    text.textContent = spec.text;
    el.append(rect, text);
    const length = spec.path.getTotalLength();
    this.place(el, spec.path, spec.reverse ? length : 0);
    this.layer.append(el);
    this.moving.push({ ...spec, el, length, startedAt: now });
    spec.onLaunch?.();
  }

  private place(el: SVGGElement, path: SVGPathElement, at: number) {
    const p = path.getPointAtLength(at);
    el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  private frame = (now: number) => {
    this.frameId = 0;
    while (this.queue.length && this.moving.length < MAX_MOVING && now >= this.nextLaunchAt) {
      this.launch(this.queue.shift()!, now);
      this.nextLaunchAt = now + STAGGER_MS / this.speed;
    }
    if (this.merged && !this.queue.length && this.moving.length < MAX_MOVING && now >= this.nextLaunchAt) {
      const { specs, minor } = this.merged;
      this.merged = null;
      const last = specs.at(-1)!;
      this.launch({ ...last, text: this.formatMerged(specs.length, minor), outline: false, onLaunch: () => specs.forEach((s) => s.onLaunch?.()), onArrive: () => specs.forEach((s) => s.onArrive?.()) }, now);
      this.nextLaunchAt = now + STAGGER_MS / this.speed;
    }
    const travel = TRAVEL_MS / this.speed;
    this.moving = this.moving.filter((m) => {
      const p = Math.min((now - m.startedAt) / travel, 1);
      const done = ease(p) * m.length;
      this.place(m.el, m.path, m.reverse ? m.length - done : done);
      if (p < 1) return true;
      m.el.remove();
      m.onArrive?.();
      return false;
    });
    for (const [key, c] of this.counters) {
      const p = Math.min((now - c.startedAt) / COUNT_MS, 1);
      c.set(Math.round(c.from + (c.to - c.from) * easeOut(p)));
      if (p >= 1) this.counters.delete(key);
    }
    if (this.busy || this.counters.size) this.run();
    else this.onIdle();
  };
}
