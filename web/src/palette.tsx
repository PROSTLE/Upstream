import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { CornerDownLeft, HandCoins, Moon, RefreshCw, Search, Sun, TerminalSquare } from "lucide-react";
import { api } from "./api.ts";
import { ago, plural } from "./format.ts";
import { applyTheme } from "./theme.ts";
import { Kbd, useToast } from "./ui.tsx";

export interface NavItem { to: string; label: string; icon: any; keywords?: string }
type Item = { id: string; group: string; label: string; hint?: string; icon: ReactNode; keywords?: string; run: () => void | Promise<void> };

/** Subsequence match, so "plpy" finds "Plan payout"; tighter matches rank first. */
function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - i;
  let pos = -1, gaps = 0;
  for (const ch of q) {
    const n = t.indexOf(ch, pos + 1);
    if (n < 0) return 0;
    gaps += n - pos - 1;
    pos = n;
  }
  return Math.max(1, 50 - gaps);
}

export function CommandPalette({ nav, onClose }: { nav: NavItem[]; onClose: () => void }) {
  const go = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [sessions, setSessions] = useState<any[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.focus();
    api<any[]>("/api/sessions").then((s) => setSessions(s.slice(0, 8)), () => {});
  }, []);

  const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
    (!document.documentElement.getAttribute("data-theme") && window.matchMedia?.("(prefers-color-scheme: dark)").matches);

  const items: Item[] = useMemo(() => [
    ...nav.map((n) => ({ id: `nav:${n.to}`, group: "Go to", label: n.label, keywords: n.keywords, icon: <n.icon size={16} />, run: () => go(n.to) })),
    {
      id: "act:plan", group: "Actions", label: "Plan a payout", hint: "Payouts", keywords: "settle paypal batch money", icon: <HandCoins size={16} />,
      run: async () => {
        const s = await api<any>("/api/settlements/plan", { body: {}, admin: true });
        if (s.status === "empty") toast("Nothing to settle yet: no attributed sessions or claimable reservations.", "error");
        else go(`/settlements/${s.id}`);
      },
    },
    {
      id: "act:sync", group: "Actions", label: "Sync funding from PayPal", hint: "Funding", keywords: "subscription transactions refresh", icon: <RefreshCw size={16} />,
      run: async () => {
        const r = await api<{ status: string; booked: number }>("/api/funding/sync", { body: {}, admin: true });
        toast(`PayPal says ${r.status}; ${plural(r.booked, "new payment")} booked.`);
      },
    },
    {
      id: "act:refresh", group: "Actions", label: "Refresh package metadata", hint: "deps.dev · ecosyste.ms", keywords: "repo funding github", icon: <RefreshCw size={16} />,
      run: async () => {
        const r = await api<{ refreshed: number }>("/api/packages/refresh", { body: {}, admin: true });
        toast(`Refreshed ${plural(r.refreshed, "package")}.`);
      },
    },
    {
      id: "act:theme", group: "Actions", label: dark ? "Switch to light theme" : "Switch to dark theme", keywords: "dark light mode appearance", icon: dark ? <Sun size={16} /> : <Moon size={16} />,
      run: () => applyTheme(dark ? "light" : "dark"),
    },
    ...sessions.map((s) => ({
      id: `ses:${s.id}`, group: "Recent sessions", label: s.project ?? "unknown project", hint: ago(s.last_event_at),
      keywords: `${s.id} ${s.top.map((t: any) => t.name).join(" ")}`, icon: <TerminalSquare size={16} />, run: () => go(`/sessions/${s.id}`),
    })),
  ], [nav, sessions, dark, go, toast]);

  const shown = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return items
      .map((it) => ({ it, s: Math.max(score(qq, it.label), score(qq, it.keywords ?? "") * 0.6) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (qq ? b.s - a.s : 0))
      .map((x) => x.it);
  }, [items, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = async (it: Item | undefined) => {
    if (!it) return;
    onClose();
    try {
      await it.run();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  let lastGroup = "";
  return (
    <div className="modal-back palette-back" onClick={onClose}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={18} color="var(--muted)" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to a page, a session, or run an action…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[sel] ? `pi-${sel}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); void run(shown[sel]); }
              else if (e.key === "Escape") onClose();
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <div className="muted small" style={{ padding: 14 }}>No matches for “{q}”.</div>}
          {shown.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="palette-group">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head}
                <button id={`pi-${i}`} role="option" aria-selected={i === sel} className="palette-item" onMouseMove={() => setSel(i)} onClick={() => void run(it)}>
                  <span style={{ color: "var(--muted)", display: "grid" }}>{it.icon}</span>
                  {it.label}
                  {it.hint && <span className="hint">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span className="row" style={{ gap: 6 }}><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="row" style={{ gap: 6 }}><Kbd><CornerDownLeft size={10} /></Kbd> open</span>
          <span className="row" style={{ gap: 6 }}><Kbd>Ctrl</Kbd><Kbd>K</Kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
