// "Watch the money move." One diagram in three sizes: the whole pool (Money records), a short version (Overview), and one payout (its own page).
// Tokens only ever move for events PayPal confirmed or Upstream's own labelled holds, and exact numbers stay on screen as text.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check, ChevronDown, CircleDollarSign, Pause, Play, Repeat2, Square, X } from "lucide-react";
import { api } from "../api.ts";
import { dateTime, money, moneyStr, plural, shortId } from "../format.ts";
import { TrailDrawer } from "../trail.tsx";
import { Empty, ErrorBox, useToast } from "../ui.tsx";
import { TokenEngine } from "./engine.ts";
import { batchLayout, compactLayout, fullLayout, type Layout } from "./layout.ts";
import { MoneyFeed } from "./MoneyFeed.tsx";
import { useMoneyStream, type FlowNode, type FlowSummary, type MoneyEvent, type StreamStatus } from "./stream.tsx";

// ---------- what each node shows ----------

const TONE: Record<FlowNode, string> = { funders: "accent", pool: "violet", paypal: "accent", maintainers: "teal", unclaimed: "amber", held: "amber", fees: "neutral" };

function nodeValues(s: FlowSummary): Record<FlowNode, number> {
  return {
    funders: s.fundingGross,
    pool: s.available,
    paypal: s.inFlight,
    maintainers: s.paidSuccess,
    unclaimed: s.unclaimedAtPaypal,
    held: s.reserved,
    fees: -s.fundingFees - s.payoutFees,
  };
}

/** How much has travelled each main path, which sets how thick it's drawn. */
function pathAmounts(s: FlowSummary): Record<string, number> {
  return {
    "funders>pool": s.fundingGross,
    "pool>paypal": s.paidSuccess + s.unclaimedAtPaypal + s.inFlight,
    "paypal>maintainers": s.paidSuccess,
    "pool>held": s.reserved,
    "pool>fees": -s.fundingFees - s.payoutFees,
    "paypal>unclaimed": s.unclaimedAtPaypal,
  };
}

const edgeTone = (key: string) => TONE[key.split(">")[0] as FlowNode] ?? "accent";
const edgeWidth = (amount: number, total: number, max: number) => (amount <= 0 ? 0 : Math.min(max, 2 + (amount / Math.max(total, 1)) * (max - 2)));

// ---------- the drawing ----------

interface NodeView {
  key: string;
  tone: string;
  title: ReactNode;
  sub?: ReactNode;
  href: string;
  label: string;
  /** Number shown by the engine, so it can count without React rendering every frame. */
  counted?: boolean;
  chip?: boolean;
  dashed?: boolean;
  stripeDashed?: boolean;
  muted?: boolean;
  body?: ReactNode;
  /** The last real event that touched this node, for its tooltip. */
  lastEvent?: string;
}

/** Everything the engine and the drawing share. */
function useDiagram(currency: string | undefined, onIdle: () => void) {
  const layer = useRef<SVGGElement | null>(null);
  const engine = useRef<TokenEngine | null>(null);
  const paths = useRef(new Map<string, SVGPathElement>());
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const amounts = useRef(new Map<string, HTMLElement>());
  const shown = useRef(new Map<string, number>());
  const cur = useRef(currency);
  cur.current = currency;
  const idle = useRef(onIdle);
  idle.current = onIdle;

  const attachLayer = useCallback((el: SVGGElement | null) => {
    layer.current = el;
    engine.current?.clear();
    engine.current = el ? new TokenEngine(el, () => idle.current(), (n, minor) => `+${n} more · ${money(minor, cur.current ?? "USD")}`) : null;
  }, []);

  const setNumber = useCallback((key: string, value: number, animate = true) => {
    const el = amounts.current.get(key);
    if (!el) return;
    const fmt = (v: number) => money(v, cur.current ?? "USD");
    const from = shown.current.get(key);
    const set = (v: number) => {
      el.textContent = fmt(v);
      shown.current.set(key, v);
    };
    if (!animate || from === undefined || !engine.current) set(value);
    else engine.current.count(el, set, from, value);
  }, []);

  const pulse = useCallback((key: string) => {
    const el = nodes.current.get(key);
    if (!el) return;
    el.classList.add("pulse");
    setTimeout(() => el.classList.remove("pulse"), 280);
  }, []);

  const pathFor = useCallback((from: string, to: string) => {
    const forward = paths.current.get(`${from}>${to}`);
    if (forward) return { el: forward, reverse: false };
    const back = paths.current.get(`${to}>${from}`);
    return back ? { el: back, reverse: true } : null;
  }, []);

  const highlight = useCallback((from: string, to: string) => {
    const p = pathFor(from, to);
    if (!p) return;
    p.el.classList.add("hot");
    setTimeout(() => p.el.classList.remove("hot"), 700);
  }, [pathFor]);

  return { attachLayer, engine, paths, nodes, amounts, setNumber, pulse, pathFor, highlight };
}

function Diagram({ layout, views, diagram, amountsByPath, total, title, description }: {
  layout: Layout;
  views: NodeView[];
  diagram: ReturnType<typeof useDiagram>;
  amountsByPath?: Record<string, number>;
  total?: number;
  title: string;
  description: string;
}) {
  const nav = useNavigate();
  const [tip, setTip] = useState<string | null>(null);
  const maxWidth = layout.shape === "vertical" ? 10 : 24;
  const visible = new Set(layout.visible);
  const tipView = tip && layout.boxes[tip] ? views.find((v) => v.key === tip) : undefined;
  return (
    <div className="mf-drawing" style={{ height: layout.height }}>
      <svg className="mf-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={title}>
        <title>{title}</title>
        <desc>{description}</desc>
        {Object.entries(layout.paths).map(([key, d]) => {
          const amount = amountsByPath?.[key];
          const width = amount === undefined ? undefined : edgeWidth(amount, total ?? 0, maxWidth);
          const shownPath = visible.has(key);
          return (
            <path
              key={key}
              ref={(el) => {
                if (el) diagram.paths.current.set(key, el);
                else diagram.paths.current.delete(key);
              }}
              d={d}
              className={`mf-edge ${shownPath ? "" : "travel"} ${shownPath && width === 0 ? "zero" : ""}`}
              style={{ "--edge": `var(--tone-${edgeTone(key)})`, strokeWidth: shownPath ? (width === 0 ? 1.5 : width ?? 3) : undefined } as React.CSSProperties}
            />
          );
        })}
        {views.map((v) => {
          const b = layout.boxes[v.key];
          if (!b) return null;
          return (
            <a
              key={v.key}
              href={v.href}
              aria-label={v.label}
              className="mf-link"
              onClick={(e) => {
                e.preventDefault();
                nav(v.href);
              }}
              onMouseEnter={() => setTip(v.key)}
              onMouseLeave={() => setTip(null)}
              onFocus={() => setTip(v.key)}
              onBlur={() => setTip(null)}
            >
              <foreignObject x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8}>
                <div
                  ref={(el) => {
                    if (el) diagram.nodes.current.set(v.key, el);
                    else diagram.nodes.current.delete(v.key);
                  }}
                  className={`mf-node ${b.chip ? "chip" : ""} ${layout.shape === "vertical" ? "row-node" : ""} ${v.dashed ? "dashed" : ""} ${v.stripeDashed ? "stripe-dashed" : ""} ${v.muted ? "muted" : ""}`}
                  style={{ width: b.w, height: b.h, "--stripe": `var(--tone-${v.tone})` } as React.CSSProperties}
                >
                  {v.body ?? (
                    <>
                      <span className="mf-title">{v.title}</span>
                      {v.counted && (
                        <span
                          className="mf-amount"
                          ref={(el) => {
                            if (el) diagram.amounts.current.set(v.key, el);
                            else diagram.amounts.current.delete(v.key);
                          }}
                        />
                      )}
                      {v.sub && <span className="mf-sub">{v.sub}</span>}
                    </>
                  )}
                </div>
              </foreignObject>
            </a>
          );
        })}
        <g ref={diagram.attachLayer} aria-hidden="true" />
      </svg>
      {tipView && (
        <div className="mf-tip" role="tooltip" style={{ left: Math.max(Math.min(layout.boxes[tipView.key].x, layout.width - 260), 0), top: layout.boxes[tipView.key].y + layout.boxes[tipView.key].h + 6 }}>
          {tipView.label.split(". Open")[0]}
          {tipView.lastEvent && <div className="muted">Last: {tipView.lastEvent}</div>}
        </div>
      )}
    </div>
  );
}

// ---------- preferences and timing ----------

const MOTION_KEY = "upstream.motion";
function readMotion(): "on" | "paused" | null {
  try {
    const v = localStorage.getItem(MOTION_KEY);
    return v === "on" || v === "paused" ? v : null;
  } catch {
    return null;
  }
}
function writeMotion(v: "on" | "paused" | null) {
  try {
    if (v) localStorage.setItem(MOTION_KEY, v);
    else localStorage.removeItem(MOTION_KEY);
  } catch {
    // Storage can be unavailable; the choice then lasts for this page.
  }
}

/** Tokens move unless someone paused them, or their system asks for less motion and they haven't said otherwise. The CSS rule for this doesn't stop JavaScript. */
function useMotion() {
  const query = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)"), []);
  const [reduced, setReduced] = useState(query.matches);
  const [pref, setPref] = useState(readMotion);
  useEffect(() => {
    const f = () => setReduced(query.matches);
    query.addEventListener("change", f);
    return () => query.removeEventListener("change", f);
  }, [query]);
  const on = pref === "on" || (pref === null && !reduced);
  const choose = (v: "on" | "paused") => {
    writeMotion(v);
    setPref(v);
  };
  return { on, reducedOff: reduced && pref !== "on" && pref !== "paused", paused: pref === "paused", pause: () => choose("paused"), resume: () => choose("on") };
}

function useWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    if (!el) return;
    setWidth(Math.floor(el.clientWidth));
    observer.current = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    observer.current.observe(el);
  }, []);
  return [ref, width] as const;
}

const tokenText = (e: MoneyEvent) => (e.type === "earmark" && e.to === "held" ? `${money(e.amount_minor, e.currency)} held` : money(e.amount_minor, e.currency));
const tokenTone = (e: MoneyEvent) => (e.to === "held" && (e.from === "unclaimed" || e.from === "maintainers") ? "violet" : TONE[e.from as FlowNode] ?? "accent");

const clampGap = (a: string, b: string, speed: number) => Math.min(1500, Math.max(250, new Date(b).getTime() - new Date(a).getTime())) / speed;

/** Plays real past events one after another. Live events that arrive meanwhile are the caller's to hold back. */
function useReplay(play: (e: MoneyEvent) => void, onEnd: () => void) {
  const [info, setInfo] = useState<{ count: number; first: string; last: string; speed: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(false);
  const stop = useCallback(() => {
    clearTimeout(timer.current);
    if (!active.current) return;
    active.current = false;
    setInfo(null);
    onEnd();
  }, [onEnd]);
  const start = useCallback((events: MoneyEvent[], speed: number) => {
    if (!events.length) return;
    active.current = true;
    setInfo({ count: events.length, first: events[0].at, last: events.at(-1)!.at, speed });
    const step = (i: number) => {
      if (i >= events.length) {
        timer.current = setTimeout(stop, 1600 / speed);
        return;
      }
      play(events[i]);
      timer.current = setTimeout(() => step(i + 1), i + 1 < events.length ? clampGap(events[i].at, events[i + 1].at, speed) : 0);
    };
    step(0);
  }, [play, stop]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { info, start, stop };
}

// ---------- header ----------

const STATUS_COPY: Record<StreamStatus, string> = {
  connecting: "Connecting…",
  live: "Live · updates the moment PayPal confirms",
  reconnecting: "Reconnecting… missed events will catch up",
  polling: "Live updates every 5 s (streaming unavailable)",
  offline: "Not connected",
};
const STATUS_TONE: Record<StreamStatus, string> = { connecting: "", live: "green live", reconnecting: "amber", polling: "blue", offline: "red" };

function StatusPill({ status }: { status: StreamStatus }) {
  return <span className={`pill ${STATUS_TONE[status]} mf-status`} role="status"><span className="dot" />{STATUS_COPY[status]}</span>;
}

function ReplayBanner({ info, onStop, numbers }: { info: { count: number; first: string; last: string; speed: number }; onStop: () => void; numbers?: boolean }) {
  return (
    <div className="callout blue mf-banner" role="status">
      <Repeat2 size={16} color="var(--accent)" />
      <div className="small" style={{ flex: 1 }}>Replaying {plural(info.count, "real event")} from {dateTime(info.first)} to {dateTime(info.last)} at {info.speed}×{numbers && " · numbers show what moved in this replay"}</div>
      <button className="btn sm" onClick={onStop}><Square size={13} />Stop</button>
    </div>
  );
}

// ---------- the whole pool ----------

const FOUR_RANGES = [
  { label: "Last 24 h", ms: 24 * 3600e3 },
  { label: "Last 7 days", ms: 7 * 24 * 3600e3 },
  { label: "Last 30 days", ms: 30 * 24 * 3600e3 },
  { label: "Everything", ms: null },
];

function TotalsLine({ s }: { s: FlowSummary }) {
  const cur = s.currency;
  const v = nodeValues(s);
  const parts: [string, number][] = [["fees", v.fees], ["paid", v.maintainers], ["waiting", v.unclaimed], ["at PayPal", v.paypal], ["held", v.held], ["available", s.headroom]];
  const sum = parts.reduce((a, [, n]) => a + n, 0);
  const gap = s.fundingGross - sum;
  return (
    <p className="mf-totals small">
      In <strong className="num">{money(s.fundingGross, cur)}</strong> = {parts.map(([label, n], i) => <span key={label}>{i > 0 && " + "}{label} <span className="num">{money(n, cur)}</span></span>)}{" "}
      {gap === 0
        ? <span className="mf-adds-up"><Check size={13} aria-hidden /> adds up</span>
        : <span className="mf-adds-up off"><X size={13} aria-hidden /> differs by {money(gap, cur)}</span>}
    </p>
  );
}

export function MoneyFlow({ variant }: { variant: "full" | "compact" }) {
  const stream = useMoneyStream();
  const compact = variant === "compact";
  const motion = useMotion();
  const toast = useToast();
  const [outerRef, outerWidth] = useWidth<HTMLDivElement>();
  const [drawRef, drawWidth] = useWidth<HTMLDivElement>();
  const [menu, setMenu] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [trail, setTrail] = useState<string | null>(null);
  const s = stream.summary;
  const moved = useRef<Record<string, number> | null>(null);
  const deferred = useRef<MoneyEvent[]>([]);
  const motionOn = useRef(motion.on);
  motionOn.current = motion.on;
  const shownFirst = useRef(false);

  const applyLive = useCallback((animate: boolean) => {
    const live = stream.summaryRef.current;
    if (!live || moved.current) return;
    const v = nodeValues(live);
    for (const key of Object.keys(v) as FlowNode[]) diagramRef.current?.setNumber(key, v[key], animate);
  }, [stream.summaryRef]);

  const diagram = useDiagram(s?.currency, () => applyLive(true));
  const diagramRef = useRef(diagram);
  diagramRef.current = diagram;

  /** One event on the diagram: a token when motion is on, otherwise a brief highlight. Numbers are real at every step. */
  const showEvent = useCallback((e: MoneyEvent, opts: { replay?: boolean; animate: boolean }) => {
    if (!e.from || !e.to) return;
    const from = e.from;
    const to = e.to;
    const d = diagramRef.current;
    const value = (key: FlowNode) => {
      const live = e.summary ?? stream.summaryRef.current;
      return live ? nodeValues(live)[key] : undefined;
    };
    const arrive = () => {
      d.pulse(to);
      if (moved.current) {
        moved.current[to] = (moved.current[to] ?? 0) + (to === "funders" ? -e.amount_minor : e.amount_minor);
        d.setNumber(to, moved.current[to]);
      } else {
        const v = value(to);
        if (v !== undefined) d.setNumber(to, v);
      }
    };
    const depart = () => {
      if (moved.current) {
        if (from === "funders") {
          moved.current.funders = (moved.current.funders ?? 0) + e.amount_minor;
          d.setNumber("funders", moved.current.funders);
        }
      } else {
        const v = value(from);
        if (v !== undefined) d.setNumber(from, v);
      }
    };
    const path = d.pathFor(from, to);
    const canMove = opts.replay ? !window.matchMedia("(prefers-reduced-motion: reduce)").matches || motionOn.current : motionOn.current;
    if (opts.animate && canMove && path && d.engine.current) {
      d.engine.current.enqueue({ path: path.el, reverse: path.reverse, text: tokenText(e), amountMinor: e.amount_minor, tone: tokenTone(e), outline: e.type === "earmark", onLaunch: depart, onArrive: arrive });
    } else {
      if (opts.animate) d.highlight(from, to);
      depart();
      arrive();
    }
  }, [stream.summaryRef]);

  const endReplay = useCallback(() => {
    moved.current = null;
    if (diagramRef.current.engine.current) diagramRef.current.engine.current.speed = 1;
    applyLive(true);
    const held = deferred.current;
    deferred.current = [];
    if (held.length && held.length <= 10) held.forEach((e) => showEvent(e, { animate: true }));
  }, [applyLive, showEvent]);

  const replay = useReplay(useCallback((e: MoneyEvent) => showEvent(e, { replay: true, animate: true }), [showEvent]), endReplay);

  useEffect(() => stream.subscribe((e, meta) => {
    if (meta.initial) return;
    if (moved.current) deferred.current.push(e);
    else showEvent(e, { animate: meta.animate });
  }), [stream.subscribe, showEvent]);

  const narrow = outerWidth < 720;
  const layout = useMemo(() => (drawWidth > 0 ? (compact ? compactLayout(drawWidth) : fullLayout(drawWidth, narrow)) : null), [compact, drawWidth, narrow]);

  // Numbers follow the server's summary whenever nothing is moving; a token in flight sets its own number when it lands.
  useEffect(() => {
    if (!s || !layout) return;
    if (!diagram.engine.current?.busy) applyLive(shownFirst.current);
    shownFirst.current = true;
  }, [s, layout, applyLive, diagram.engine]);

  useEffect(() => diagram.engine.current?.clear(), [layout?.shape, diagram.engine]);

  const startReplay = async (ms: number | null) => {
    setMenu(false);
    try {
      const query = ms ? `from=${encodeURIComponent(new Date(Date.now() - ms).toISOString())}` : "all=1";
      const r = await api<{ events: MoneyEvent[] }>(`/api/money/events?${query}&limit=1000`);
      const events = r.events.filter((e) => e.from && e.to);
      if (!events.length) return toast("No money events in that period.");
      moved.current = {};
      for (const key of Object.keys(TONE)) diagram.setNumber(key, 0, false);
      if (diagram.engine.current) diagram.engine.current.speed = speed;
      replay.start(events, speed);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const heading = (
    <div className="mf-head">
      {!compact && <h2>Money in motion</h2>}
      <StatusPill status={stream.status} />
      {motion.paused && <span className="pill">Motion paused · numbers still update</span>}
      {motion.reducedOff && (
        <span className="pill">
          Motion is off because your system prefers reduced motion ·{" "}
          <button type="button" className="mf-link-btn" onClick={motion.resume}>Turn on</button>
        </span>
      )}
      <div className="spacer" />
      {!motion.reducedOff && (
        <button className="btn sm" onClick={motion.on ? motion.pause : motion.resume}>
          {motion.on ? <><Pause size={13} />Pause motion</> : <><Play size={13} />Resume motion</>}
        </button>
      )}
      {!compact && (
        <div className="mf-menu-wrap">
          <button className="btn sm" aria-haspopup="menu" aria-expanded={menu} disabled={Boolean(replay.info)} onClick={() => setMenu((m) => !m)}><Repeat2 size={13} />Replay<ChevronDown size={13} /></button>
          {menu && (
            <div className="mf-menu" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenu(false)}>
              {FOUR_RANGES.map((r) => <button key={r.label} role="menuitem" className="mf-menu-item" onClick={() => void startReplay(r.ms)}>{r.label}</button>)}
              <div className="mf-menu-speed">
                <span className="muted small">Speed</span>
                <div className="tabs">
                  {[1, 4, 16].map((n) => <button key={n} className={`tab ${speed === n ? "active" : ""}`} aria-pressed={speed === n} onClick={() => setSpeed(n)}>{n}×</button>)}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (stream.error && !s) {
    return (
      <div className="stack">
        <ErrorBox error={stream.error} />
        <div className="row"><button className="btn" onClick={stream.retry}>Retry</button></div>
      </div>
    );
  }

  const cur = s?.currency ?? "USD";
  const v = s ? nodeValues(s) : null;
  const latest = stream.latestSettlementId ? `/settlements/${stream.latestSettlementId}` : "/settlements";
  const payoutWord = stream.latestSettlementId ? "the latest payout" : "Pay maintainers";
  const amt = (key: FlowNode) => money(v?.[key] ?? 0, cur);
  const views: NodeView[] = [
    { key: "funders", tone: "accent", title: "Money in", counted: true, href: "/funding", label: `Money in: ${amt("funders")}. Open Add funds.` },
    { key: "pool", tone: "violet", title: "Your pool", counted: true, sub: compact ? undefined : `balance ${money(s?.balance ?? 0, cur)}`, href: "/settlements", label: `Your pool: ${amt("pool")} available, balance ${money(s?.balance ?? 0, cur)}. Open Pay maintainers.` },
    { key: "paypal", tone: "accent", title: "At PayPal", counted: true, dashed: (v?.paypal ?? 0) > 0, sub: compact ? undefined : "includes fee reserve until PayPal reports fees", href: latest, label: `At PayPal: ${amt("paypal")}, including the fee reserve until PayPal reports fees. Open ${payoutWord}.` },
    { key: "maintainers", tone: "teal", title: compact ? "Paid" : "Paid to maintainers", counted: true, href: latest, label: `Paid to maintainers: ${amt("maintainers")}. Open ${payoutWord}.` },
    { key: "unclaimed", tone: "amber", title: compact ? "waiting" : "Waiting for claim", counted: true, sub: compact ? undefined : "PayPal returns it after 30 days", href: latest, label: `Waiting for claim: ${amt("unclaimed")}. PayPal returns it after 30 days. Open ${payoutWord}.` },
    { key: "held", tone: "amber", stripeDashed: true, title: compact ? "held" : "Held", counted: true, sub: compact ? undefined : "No PayPal call · waiting for a maintainer", href: "/packages", label: `Held: ${amt("held")}. No PayPal call, waiting for a maintainer. Open Maintainers.` },
    { key: "fees", tone: "neutral", muted: true, title: compact ? "fees" : "PayPal fees", counted: true, href: "/ledger?group=fees", label: `PayPal fees: ${amt("fees")}. Open Money records.` },
  ];
  for (const view of views) view.lastEvent = stream.events.find((e) => e.to === view.key || e.from === view.key)?.label;
  // 1100 px wide for the card, which is about 1040 inside its padding.
  const side = !compact && outerWidth >= 1040;
  const feedHeight = layout ? (side ? layout.height + 8 : 360) : 360;
  const description = s ? `Money in ${money(s.fundingGross, cur)}, your pool ${money(s.available, cur)} available, at PayPal ${money(s.inFlight, cur)}, paid to maintainers ${money(s.paidSuccess, cur)}, waiting for claim ${money(s.unclaimedAtPaypal, cur)}, held ${money(s.reserved, cur)}, PayPal fees ${money(v!.fees, cur)}.` : "Loading the money totals.";

  return (
    <div className="mf-wrap" ref={outerRef}>
      {heading}
      {replay.info && <ReplayBanner info={replay.info} onStop={replay.stop} numbers />}
      {s && s.fundingGross === 0 && !stream.events.length && (
        <div className="callout">
          <CircleDollarSign size={16} color="var(--muted)" />
          <div className="small" style={{ flex: 1 }}>No money has moved yet. When PayPal confirms your first payment, you'll see it flow in here.</div>
          <Link className="btn sm" to="/funding">Add funds</Link>
        </div>
      )}
      <div className={`mf-main ${side ? "side" : ""}`}>
        <div className="mf-diagram" ref={drawRef}>
          {layout && <Diagram layout={layout} views={views} diagram={diagram} amountsByPath={s ? pathAmounts(s) : undefined} total={s?.fundingGross} title="Where the money is" description={description} />}
        </div>
        {!compact && <MoneyFeed events={stream.events} maxHeight={feedHeight} onTrail={setTrail} />}
      </div>
      {s && <TotalsLine s={s} />}
      {compact
        ? <Link className="small" to="/ledger">Watch every event in Money records ›</Link>
        : <a className="small" href="#ledger-entries">View as table</a>}
      {trail && <TrailDrawer repo={trail} onClose={() => setTrail(null)} />}
    </div>
  );
}

// ---------- one payout ----------

const ITEM_STATUS: Record<string, { text: string; tone: string }> = {
  SUCCESS: { text: "✓ Paid", tone: "green" },
  PENDING: { text: "⏳ Processing", tone: "blue" },
  UNCLAIMED: { text: "⚠ Waiting for claim (≤30 days)", tone: "amber" },
  ONHOLD: { text: "⚠ On hold for review", tone: "amber" },
  RETURNED: { text: "↩ Returned, held again", tone: "violet" },
  REFUNDED: { text: "↩ Refunded, held again", tone: "violet" },
  REVERSED: { text: "↩ Reversed, held again", tone: "violet" },
  FAILED: { text: "✕ Not paid, held again", tone: "red" },
  BLOCKED: { text: "✕ Blocked, held again", tone: "red" },
};

export function BatchFlow({ settlement: s }: { settlement: any }) {
  const stream = useMoneyStream();
  const motion = useMotion();
  const toast = useToast();
  const [drawRef, drawWidth] = useWidth<HTMLDivElement>();
  const diagram = useDiagram(s.currency, () => {});
  const diagramRef = useRef(diagram);
  diagramRef.current = diagram;
  const motionOn = useRef(motion.on);
  motionOn.current = motion.on;
  const replaying = useRef(false);

  const itemKeys = useMemo(() => (s.items as any[]).map((i) => `item:${i.sender_item_id}`), [s.items]);
  const layout = useMemo(() => (drawWidth > 0 ? batchLayout(drawWidth, itemKeys) : null), [drawWidth, itemKeys]);

  const showEvent = useCallback((e: MoneyEvent, forced: boolean) => {
    const d = diagramRef.current;
    const [from, to] = e.type === "batch" ? ["pool", "paypal"] : e.type === "payout_status" && e.from && e.to && e.ref_id ? (e.to === "held" ? [`item:${e.ref_id}`, "paypal"] : ["paypal", `item:${e.ref_id}`]) : [null, null];
    if (!from || !to) return;
    const path = d.pathFor(from, to);
    if (!path) return;
    if ((motionOn.current || forced) && d.engine.current) {
      d.engine.current.enqueue({ path: path.el, reverse: path.reverse, text: money(e.amount_minor, e.currency), amountMinor: e.amount_minor, tone: e.to === "held" ? "violet" : e.to === "unclaimed" ? "amber" : e.type === "batch" ? "violet" : "accent", outline: false, onArrive: () => d.pulse(to) });
    } else {
      d.highlight(from, to);
      d.pulse(to);
    }
  }, []);

  const replay = useReplay(useCallback((e: MoneyEvent) => showEvent(e, !window.matchMedia("(prefers-reduced-motion: reduce)").matches), [showEvent]), useCallback(() => {
    replaying.current = false;
    if (diagramRef.current.engine.current) diagramRef.current.engine.current.speed = 1;
  }, []));

  useEffect(() => stream.subscribe((e, meta) => {
    if (e.settlement_id !== s.id || meta.initial || !meta.animate || replaying.current) return;
    showEvent(e, false);
  }), [stream.subscribe, s.id, showEvent]);

  const total = (s.items as any[]).reduce((a, i) => a + i.amount_minor, 0);
  const n = s.items.length;
  const views: NodeView[] = [
    { key: "pool", tone: "violet", title: "Your pool", href: "/settlements", label: "Your pool. Open Pay maintainers.", sub: "Where this payout came from" },
    {
      key: "paypal",
      tone: "accent",
      href: `/settlements/${s.id}`,
      label: s.payout_batch_id ? `PayPal batch ${s.payout_batch_id}, ${plural(n, "payment")}, ${money(total, s.currency)}.` : `Not sent to PayPal yet, ${plural(n, "payment")}, ${money(total, s.currency)}.`,
      title: s.payout_batch_id ? `PayPal batch ${shortId(s.payout_batch_id, 8)}` : s.status === "held" ? "No PayPal call" : "Not sent to PayPal yet",
      sub: `${plural(n, "payment")} · ${money(total, s.currency)}`,
    },
    ...(s.items as any[]).map((i): NodeView => {
      const status = ITEM_STATUS[i.transaction_status ?? (s.status === "sent" ? "PENDING" : "")] ?? { text: "Not sent yet", tone: "" };
      const repo = i.repo.replace("github.com/", "");
      return {
        key: `item:${i.sender_item_id}`,
        tone: status.tone === "green" ? "teal" : status.tone === "amber" ? "amber" : status.tone === "violet" ? "violet" : "accent",
        href: `/settlements/${s.id}`,
        label: `${repo}: ${moneyStr(i.amount, s.currency)}. ${status.text.replace(/^\S+\s/, "")}.`,
        title: repo,
        body: (
          <span className="mf-item-row">
            <span className="mf-title mf-repo">{repo}</span>
            <span className="num" style={{ fontWeight: 650 }}>{moneyStr(i.amount, s.currency)}</span>
            <span className={`pill ${status.tone}`}>{status.text}</span>
          </span>
        ),
      };
    }),
  ];

  return (
    <div className="mf-wrap">
      <div className="mf-head">
        <StatusPill status={stream.status} />
        {motion.paused && <span className="pill">Motion paused · numbers still update</span>}
        {motion.reducedOff && <span className="pill">Motion is off because your system prefers reduced motion · <button type="button" className="mf-link-btn" onClick={motion.resume}>Turn on</button></span>}
        <div className="spacer" />
        <button
          className="btn sm"
          disabled={Boolean(replay.info)}
          title="Plays this payout's real events again on the diagram. It sends nothing to PayPal."
          onClick={async () => {
            try {
              const r = await api<{ events: MoneyEvent[] }>(`/api/money/events?settlement_id=${encodeURIComponent(s.id)}&limit=1000`);
              const events = r.events.filter((e) => (e.type === "batch" || e.type === "payout_status") && e.from && e.to);
              if (!events.length) return toast("This payout has no PayPal events to replay yet.");
              replaying.current = true;
              if (diagram.engine.current) diagram.engine.current.speed = 4;
              replay.start(events, 4);
            } catch (e) {
              toast((e as Error).message, "error");
            }
          }}
        >
          <Repeat2 size={13} />Replay animation
        </button>
      </div>
      {replay.info && <ReplayBanner info={replay.info} onStop={replay.stop} />}
      <div className="mf-diagram" ref={drawRef}>
        {layout && <Diagram layout={layout} views={views} diagram={diagram} title={`Payout of ${money(total, s.currency)} to ${plural(n, "maintainer")}`} description={views.map((x) => x.label).join(" ")} />}
      </div>
    </div>
  );
}

/** Exported so the empty Overview card and this file agree on what "nothing yet" says. */
export function NoMoneyYet() {
  return (
    <Empty icon={<CircleDollarSign size={22} />} title="No money has moved yet" action={<Link className="btn" to="/funding">Add funds</Link>}>
      When PayPal confirms your first payment, you'll see it flow in here.
    </Empty>
  );
}
