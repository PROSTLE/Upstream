// One connection per tab to the server's money events, shared by every screen in the private dashboard.
// Streams when it can, and falls back to polling when it can't: some proxies (Cloudflare Quick Tunnels among them) don't pass
// Server-Sent Events, and a proxy may answer and then stay silent, so silence counts as a failure too.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { Link, useLocation } from "react-router-dom";
import { getAdminToken } from "../api.ts";
import { useToast } from "../ui.tsx";

export type FlowNode = "funders" | "pool" | "paypal" | "maintainers" | "unclaimed" | "held" | "fees";

export interface FlowSummary {
  currency: string;
  fundingGross: number;
  fundingFees: number;
  payoutFees: number;
  payoutsSent: number;
  returned: number;
  balance: number;
  reserved: number;
  inFlight: number;
  available: number;
  headroom: number;
  paidSuccess: number;
  unclaimedAtPaypal: number;
}

export interface MoneyEvent {
  id: number;
  type: "ledger" | "payout_status" | "batch" | "earmark";
  at: string;
  from: FlowNode | null;
  to: FlowNode | null;
  amount_minor: number;
  currency: string;
  label: string;
  kind: string | null;
  ref_type: string | null;
  ref_id: string | null;
  settlement_id: string | null;
  repo: string | null;
  status_from: string | null;
  status_to: string | null;
  paypal_ids: Record<string, string>;
  trigger: { via: "webhook"; event_id: string; event_type: string; verified: true } | { via: "api"; action: string } | { via: "none" };
  backfilled: boolean;
  summary?: FlowSummary;
}

export type StreamStatus = "connecting" | "live" | "reconnecting" | "polling" | "offline";
/** `animate`: it's worth showing moving. `initial`: part of what was already there when the page opened. */
export type EventMeta = { animate: boolean; initial: boolean };
type Handler = (e: MoneyEvent, meta: EventMeta) => void;

interface Stream {
  status: StreamStatus;
  error: string | null;
  summary: FlowSummary | null;
  /** The latest summary at this moment, for code running outside a render. */
  summaryRef: { current: FlowSummary | null };
  events: MoneyEvent[];
  latestSettlementId: string | null;
  subscribe: (fn: Handler) => () => void;
  retry: () => void;
}

const StreamCtx = createContext<Stream | null>(null);

export function useMoneyStream(): Stream {
  const s = useContext(StreamCtx);
  if (!s) throw new Error("useMoneyStream needs a MoneyStreamProvider");
  return s;
}

/** Calls `handler` for each new event that passes `filter`. */
export function useMoneyEvents(filter: (e: MoneyEvent) => boolean, handler: Handler) {
  const { subscribe } = useMoneyStream();
  const latest = useRef({ filter, handler });
  latest.current = { filter, handler };
  useEffect(() => subscribe((e, meta) => {
    if (latest.current.filter(e)) latest.current.handler(e, meta);
  }), [subscribe]);
}

/** Reloads a screen's data shortly after matching events: several events in a row cost one reload. */
export function useMoneyRefresh(filter: (e: MoneyEvent) => boolean, refresh: () => unknown) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(refresh);
  latest.current = refresh;
  useMoneyEvents(filter, (_e, meta) => {
    if (meta.initial) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(), 500);
  });
  useEffect(() => () => clearTimeout(timer.current), []);
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000];
const FAILURES_BEFORE_POLLING = 3;
const POLL_MS = 5000;
const STREAM_RETRY_MS = 60_000;
const HELLO_TIMEOUT_MS = 6000;
const SILENCE_LIMIT_MS = 45_000; // the server pings every 15 s
const KEEP_EVENTS = 50;
const CATCH_UP_OVER = 10;

class SignedOut extends Error {}

export function MoneyStreamProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<FlowSummary | null>(null);
  const [events, setEvents] = useState<MoneyEvent[]>([]);
  const [latestSettlementId, setLatestSettlement] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const summaryRef = useRef<FlowSummary | null>(null);
  const listeners = useRef(new Set<Handler>());
  const seen = useRef(new Set<number>());
  const lastId = useRef(0);
  const hadFirstLoad = useRef(false);

  const subscribe = useCallback((fn: Handler) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const applySummary = useCallback((s: FlowSummary | undefined) => {
    if (!s) return;
    summaryRef.current = s;
    setSummary(s);
  }, []);

  /** Each event reaches the screen once, however it arrived. */
  const deliver = useCallback((batch: MoneyEvent[]) => {
    const fresh = batch.filter((e) => !seen.current.has(e.id));
    for (const e of fresh) {
      seen.current.add(e.id);
      lastId.current = Math.max(lastId.current, e.id);
      if (e.settlement_id) setLatestSettlement(e.settlement_id);
    }
    if (!fresh.length) {
      hadFirstLoad.current = true;
      return;
    }
    const initial = !hadFirstLoad.current;
    hadFirstLoad.current = true;
    const animate = !initial && fresh.length <= CATCH_UP_OVER;
    setEvents((list) => [...fresh].reverse().concat(list).slice(0, KEEP_EVENTS));
    if (!initial && !animate) toast(`While this tab was hidden: ${fresh.length} money events`);
    for (const e of fresh) {
      if (e.summary) applySummary(e.summary);
      for (const fn of listeners.current) fn(e, { animate, initial });
      if (animate && !pathRef.current.startsWith("/ledger") && (e.status_to === "SUCCESS" || (e.kind === "FUNDING_GROSS" && e.amount_minor > 0))) {
        toast(<>{e.label} · <Link to="/ledger">Watch</Link></>);
      }
    }
  }, [applySummary, toast]);

  useEffect(() => {
    let stopped = false;
    let failures = 0;
    let streamCtrl: AbortController | null = null;
    let helloTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let streamRetry: ReturnType<typeof setInterval> | undefined;
    let lastByteAt = Date.now();
    let streaming = false;

    const headers = (): Record<string, string> => {
      const token = getAdminToken();
      return token ? { "x-admin-token": token } : {};
    };

    const signedOut = () => {
      stopped = true;
      stopPolling();
      setStatus("offline");
      setError("Please sign in to see money events.");
    };

    const applyHello = (d: { summary: FlowSummary; latest_settlement_id: string | null }) => {
      applySummary(d.summary);
      if (d.latest_settlement_id) setLatestSettlement(d.latest_settlement_id);
    };

    const poll = async () => {
      try {
        const res = await fetch(`/api/money/events?after=${lastId.current}`, { headers: { Accept: "application/json", ...headers() } });
        if (res.status === 401) return signedOut();
        if (!res.ok) throw new Error(`The server answered HTTP ${res.status}.`);
        const data = await res.json();
        if (stopped) return;
        deliver(data.events);
        applyHello(data);
        setError(null);
        if (!streaming) setStatus("polling");
        if (data.more) void poll();
      } catch {
        if (!streaming && !stopped) setStatus("reconnecting");
      }
    };

    const stopPolling = () => {
      clearInterval(pollTimer);
      clearInterval(streamRetry);
      pollTimer = undefined;
      streamRetry = undefined;
    };

    const startPolling = () => {
      if (pollTimer) return;
      void poll();
      pollTimer = setInterval(() => {
        if (!document.hidden) void poll();
      }, POLL_MS);
      streamRetry = setInterval(() => {
        if (!document.hidden && !streamCtrl) openStream();
      }, STREAM_RETRY_MS);
    };

    const closeStream = () => {
      clearTimeout(helloTimer);
      streaming = false;
      streamCtrl?.abort();
      streamCtrl = null;
    };

    const failed = () => {
      closeStream();
      if (stopped) return;
      failures++;
      if (failures >= FAILURES_BEFORE_POLLING) return startPolling();
      setStatus("reconnecting");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(openStream, BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]);
    };

    /** Notes when bytes last arrived, including the server's pings, which never reach onmessage. */
    const watchedFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!res.body) return res;
      const [forReader, forWatch] = res.body.tee();
      lastByteAt = Date.now();
      void (async () => {
        const reader = forWatch.getReader();
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) return;
            lastByteAt = Date.now();
          }
        } catch {
          // The stream closing is handled where it's read.
        }
      })();
      return new Response(forReader, { status: res.status, statusText: res.statusText, headers: res.headers });
    };

    const openStream = () => {
      if (stopped || streamCtrl) return;
      const ctrl = new AbortController();
      streamCtrl = ctrl;
      let backlog: MoneyEvent[] = [];
      fetchEventSource(`/api/money/stream?after=${lastId.current}`, {
        signal: ctrl.signal,
        headers: { Accept: "text/event-stream", ...headers() },
        // Closes while the tab is hidden and resumes from the last event when it's shown again.
        openWhenHidden: false,
        fetch: watchedFetch,
        async onopen(res) {
          if (res.status === 401) throw new SignedOut();
          if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) throw new Error(`The server answered HTTP ${res.status}.`);
          backlog = [];
          // Also runs when the tab is shown again: what was missed is held until "hello", so a long catch-up isn't animated one by one.
          streaming = false;
          clearTimeout(helloTimer);
          // A proxy can answer the request and then pass nothing through.
          helloTimer = setTimeout(() => {
            if (!document.hidden) failed();
          }, HELLO_TIMEOUT_MS);
        },
        onmessage(msg) {
          if (msg.event === "money") {
            const e = JSON.parse(msg.data) as MoneyEvent;
            if (streaming) deliver([e]);
            else backlog.push(e);
          } else if (msg.event === "hello") {
            clearTimeout(helloTimer);
            const data = JSON.parse(msg.data);
            streaming = true;
            failures = 0;
            stopPolling();
            setError(null);
            setStatus("live");
            deliver(backlog);
            backlog = [];
            applyHello(data);
            // More than one response can hold: this page of the backlog was full.
            if (data.more) void poll();
          }
        },
        onclose() {
          throw new Error("The stream closed.");
        },
        onerror(err) {
          // Rethrown so the retry policy below decides, not the library's fixed retry.
          throw err;
        },
      }).catch((err) => {
        if (ctrl !== streamCtrl) return;
        if (err instanceof SignedOut) {
          closeStream();
          return signedOut();
        }
        failed();
      });
    };

    const watchdog = setInterval(() => {
      if (streaming && !document.hidden && Date.now() - lastByteAt > SILENCE_LIMIT_MS) failed();
    }, 10_000);
    const onVisible = () => {
      if (!document.hidden) lastByteAt = Date.now();
    };
    const onOnline = () => {
      if (!streaming && !streamCtrl) openStream();
    };
    const onOffline = () => {
      if (streaming) failed();
      else setStatus("reconnecting");
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    setStatus("connecting");
    setError(null);
    openStream();

    return () => {
      stopped = true;
      closeStream();
      stopPolling();
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [attempt, applySummary, deliver]);

  useEffect(() => {
    const again = () => setAttempt((n) => n + 1);
    window.addEventListener("upstream:token", again);
    return () => window.removeEventListener("upstream:token", again);
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const value = { status, error, summary, summaryRef, events, latestSettlementId, subscribe, retry };
  return <StreamCtx.Provider value={value}>{children}</StreamCtx.Provider>;
}
