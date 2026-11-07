import { lazy, Suspense, useEffect, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
  ArrowLeft, ArrowLeftRight, BadgeCheck, Boxes, ExternalLink, FlaskConical, Gavel, Keyboard, KeyRound, LayoutDashboard, Lock, LogOut, Menu, Monitor, Moon, PlugZap, Search, Send,
  ShieldCheck, Sun, TerminalSquare, Wallet,
} from "lucide-react";
import { getAdminToken, setAdminToken } from "./api.ts";
import { plural } from "./format.ts";
import { MoneyStreamProvider } from "./money/stream.tsx";
import { OverviewProvider, useOverview } from "./overview.tsx";
import { CommandPalette, type NavItem } from "./palette.tsx";
import { useThemePref, type ThemePref } from "./theme.ts";
import { BrandIcon, ErrorBox, Kbd, Loading, Logo, Modal, Skeleton } from "./ui.tsx";
import { useBrand, useHealth } from "./brand.tsx";
import { useAuth } from "./auth.tsx";
const Home = lazy(() => import("./pages/Home.tsx").then((m) => ({ default: m.Home })));
const Overview = lazy(() => import("./pages/Overview.tsx").then((m) => ({ default: m.Overview })));
const Funding = lazy(() => import("./pages/Funding.tsx").then((m) => ({ default: m.Funding })));
const Sessions = lazy(() => import("./pages/Sessions.tsx").then((m) => ({ default: m.Sessions })));
const SessionDetail = lazy(() => import("./pages/SessionDetail.tsx").then((m) => ({ default: m.SessionDetail })));
const Packages = lazy(() => import("./pages/Packages.tsx").then((m) => ({ default: m.Packages })));
const Settlements = lazy(() => import("./pages/Settlements.tsx").then((m) => ({ default: m.Settlements })));
const SettlementDetail = lazy(() => import("./pages/Settlements.tsx").then((m) => ({ default: m.SettlementDetail })));
const Ledger = lazy(() => import("./pages/Ledger.tsx").then((m) => ({ default: m.Ledger })));
const Eval = lazy(() => import("./pages/Eval.tsx").then((m) => ({ default: m.Eval })));
const Connect = lazy(() => import("./pages/Connect.tsx").then((m) => ({ default: m.Connect })));
const Claim = lazy(() => import("./pages/Claim.tsx").then((m) => ({ default: m.Claim })));
const ClaimComplete = lazy(() => import("./pages/Claim.tsx").then((m) => ({ default: m.ClaimComplete })));
const PublicClaim = lazy(() => import("./pages/Claim.tsx").then((m) => ({ default: m.PublicClaim })));
const Audit = lazy(() => import("./pages/Audit.tsx").then((m) => ({ default: m.Audit })));
const Policy = lazy(() => import("./pages/Policy.tsx").then((m) => ({ default: m.Policy })));
const RepoPage = lazy(() => import("./pages/Repo.tsx").then((m) => ({ default: m.RepoPage })));
const CheckStart = lazy(() => import("./pages/Check.tsx").then((m) => ({ default: m.CheckStart })));
const CheckResult = lazy(() => import("./pages/Check.tsx").then((m) => ({ default: m.CheckResult })));

// The money flow, in order: fund → collect evidence → verify maintainers → pay → reconcile.
const FLOW: (NavItem & { step: number })[] = [
  { step: 1, to: "/funding", label: "Add funds", icon: Wallet, keywords: "subscription tithe paypal money in" },
  { step: 2, to: "/sessions", label: "Coding sessions", icon: TerminalSquare, keywords: "evidence claude code muse hook attribution" },
  { step: 3, to: "/packages", label: "Maintainers", icon: Boxes, keywords: "repos claims verified funding" },
  { step: 4, to: "/settlements", label: "Pay maintainers", icon: Send, keywords: "settlement batch paypal payouts money out" },
  { step: 5, to: "/ledger", label: "Money records", icon: ArrowLeftRight, keywords: "reconcile fees audit" },
];
const OTHER: NavItem[] = [
  { to: "/audit", label: "Safety checks", icon: ShieldCheck, keywords: "trust proof checks invariants verify reconcile" },
  { to: "/eval", label: "AI accuracy", icon: FlaskConical, keywords: "precision recall baseline labels" },
  { to: "/policy", label: "Payout rules", icon: Gavel, keywords: "policy caps limits fees reserve rules" },
  { to: "/connect", label: "Connect your agent", icon: PlugZap, keywords: "install hook mcp setup" },
];
const ALL_NAV: NavItem[] = [{ to: "/dashboard", label: "Overview", icon: LayoutDashboard, keywords: "home dashboard" }, ...FLOW, ...OTHER];

function titleFor(path: string): string {
  if (path === "/dashboard") return "Overview";
  if (path.startsWith("/sessions/")) return "Session";
  if (path.startsWith("/settlements/")) return "Payout";
  return ALL_NAV.find((n) => n.to !== "/dashboard" && path.startsWith(n.to))?.label ?? "";
}

export function App() {
  const loc = useLocation();
  const isPublic = loc.pathname === "/" || loc.pathname.startsWith("/claim") || loc.pathname.startsWith("/c/") || loc.pathname.startsWith("/r/") || loc.pathname === "/check" || loc.pathname.startsWith("/check/");
  if (isPublic) {
    return (
      <Suspense fallback={<div className="public-wrap"><div className="public-card"><Loading rows={1} /></div></div>}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/claim" element={<Claim />} />
        <Route path="/claim/complete" element={<ClaimComplete />} />
        <Route path="/c/:token" element={<PublicClaim />} />
        <Route path="/r/:owner/:name" element={<RepoPage />} />
        <Route path="/check" element={<CheckStart />} />
        <Route path="/check/:id" element={<CheckResult />} />
      </Routes>
      </Suspense>
    );
  }
  return <Gate />;
}

/** Keeps a token in sync with this browser's storage (the sidebar's Lock button and a rejected token clear it). */
function useHasToken() {
  const [has, setHas] = useState(Boolean(getAdminToken()));
  useEffect(() => {
    const f = () => setHas(Boolean(getAdminToken()));
    window.addEventListener("upstream:token", f);
    return () => window.removeEventListener("upstream:token", f);
  }, []);
  return has;
}

/** The dashboard opens for anyone signed in with GitHub, showing their own space; ADMIN_TOKEN opens the operator's. Everyone else goes home. */
function Gate() {
  const h = useHealth();
  const auth = useAuth();
  const loc = useLocation();
  const hasToken = useHasToken();
  if (h.error) return <div className="public-wrap"><div className="public-card"><ErrorBox error={`Can't reach the server: ${h.error}`} /></div></div>;
  if (!h.access || auth.loading) return <div className="public-wrap"><div className="public-card"><Loading rows={1} /></div></div>;
  const canEnter = hasToken || Boolean(auth.user);
  if (loc.pathname === "/unlock") return canEnter ? <Navigate to="/dashboard" replace /> : <Unlock />;
  if (h.access === "private" && !canEnter) return <Navigate to="/" replace />;
  return (
    <OverviewProvider>
      <MoneyStreamProvider>
        <Shell />
      </MoneyStreamProvider>
    </OverviewProvider>
  );
}

function Unlock() {
  const brand = useBrand();
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="public-wrap">
      <div className="public-card">
        <div className="hero-mark">
          <Logo size={36} />
          <div>
            <div className="brand-name" style={{ fontSize: 20 }}>{brand || <Skeleton h={20} w={100} />}</div>
            <div className="brand-sub">Sign in with a token</div>
          </div>
        </div>
        <section className="card card-pad stack">
          <div className="row" style={{ gap: 10 }}><Lock size={18} color="var(--muted)" /><h1 style={{ fontSize: 20 }}>Operator token</h1></div>
          <p className="muted">
            For the person running this server, when GitHub sign-in isn't available. The token is the <code>ADMIN_TOKEN</code> value in the server's settings. Maintainers don't need it.
          </p>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              const token = v.trim();
              try {
                // Check the token against a private endpoint first; only a token the server accepts is stored.
                const r = await fetch("/api/overview", { headers: { Accept: "application/json", "x-admin-token": token } });
                if (r.ok) setAdminToken(token);
                else setErr(r.status === 401 ? "The server rejected that token." : `The server answered HTTP ${r.status}.`);
              } catch (x) {
                setErr(`Can't reach the server: ${(x as Error).message}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="field">
              <label htmlFor="unlock-token">Admin token</label>
              <input id="unlock-token" className="input mono" type="password" autoComplete="off" autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-invalid={Boolean(err)} />
              {err ? <span className="err">{err}</span> : <span className="hint">Kept in this browser only. Lock again from the sidebar.</span>}
            </div>
            <div className="row">
              <button className="btn primary" type="submit" disabled={!v.trim() || busy}><KeyRound size={15} />Unlock</button>
              <div className="spacer" />
              <Link className="btn ghost" to="/"><ArrowLeft size={15} />Back to home</Link>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

function Shell() {
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === "?" && !typing) {
        e.preventDefault();
        setHelp(true);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <Sidebar open={menu} />
      {menu && <div className="drawer-back" style={{ zIndex: 65 }} onClick={() => setMenu(false)} />}
      <div className="main">
        <TopBar onMenu={() => setMenu(true)} onSearch={() => setPalette(true)} />
        <main id="main" tabIndex={-1} style={{ outline: "none" }}>
          <Suspense fallback={<div className="page"><Loading /></div>}>
          <Routes>
            <Route path="/dashboard" element={<Overview />} />
            <Route path="/funding" element={<Funding />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/sessions/:id" element={<SessionDetail />} />
            <Route path="/packages" element={<Packages />} />
            <Route path="/settlements" element={<Settlements />} />
            <Route path="/settlements/:id" element={<SettlementDetail />} />
            <Route path="/ledger" element={<Ledger />} />
            <Route path="/eval" element={<Eval />} />
            <Route path="/connect" element={<Connect />} />
            <Route path="/policy" element={<Policy />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </main>
      </div>
      {palette && <CommandPalette nav={ALL_NAV} onClose={() => setPalette(false)} />}
      {help && (
        <Modal title="Keyboard shortcuts" icon={<Keyboard size={17} />} onClose={() => setHelp(false)}>
          <div className="summary">
            {[
              [["Ctrl", "K"], "Open or close the command palette (⌘K on a Mac)"],
              [["/"], "Open the command palette"],
              [["↑", "↓", "Enter"], "Move through and run palette results"],
              [["Esc"], "Close a dialog, drawer or the palette"],
              [["?"], "Show this list"],
            ].map(([keys, what]) => (
              <div key={String(what)} className="line-row">
                <span className="row" style={{ gap: 4 }}>{(keys as string[]).map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
                <span className="muted small" style={{ textAlign: "right" }}>{what as string}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function NotFound() {
  return (
    <div className="page">
      <h1>Page not found</h1>
      <p className="muted">That address isn't part of the dashboard. <Link to="/dashboard">Back to the overview</Link>.</p>
    </div>
  );
}

function Sidebar({ open }: { open: boolean }) {
  const { data } = useOverview();
  const brand = useBrand();
  const hasToken = useHasToken();
  const auth = useAuth();
  const c = data?.counts;
  const done: Record<number, boolean> = data
    ? {
        1: data.subscription?.status === "ACTIVE" || data.pool.fundingGross > 0,
        2: c.attributed > 0,
        3: c.verified_claims > 0,
        4: c.settlements > 0,
        5: data.pool.payoutsSent < 0,
      }
    : {};
  const toAttribute = c ? Math.max(c.sessions - c.attributed, 0) : 0;
  return (
    <aside className={`sidebar${open ? " open" : ""}`} aria-label="Main navigation">
      <Link to="/dashboard" className="brand">
        <Logo />
        <div>
          <div className="brand-name">{brand || <Skeleton h={18} w={90} />}</div>
          <div className="brand-sub">Pay the open source you use</div>
        </div>
      </Link>
      <NavLink to="/dashboard" end className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
        <LayoutDashboard size={17} strokeWidth={1.9} className="nav-icon" />
        Overview
      </NavLink>
      <div className="nav-label">Step by step</div>
      <div className="flow-rail">
        {FLOW.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`} title={done[n.step] ? "Done" : undefined}>
            <span className={`step-dot ${done[n.step] ? "done" : ""}`} aria-label={done[n.step] ? `Step ${n.step}, done` : `Step ${n.step}`}>{n.step}</span>
            {n.label}
            {n.step === 2 && toAttribute > 0 && <span className="badge amber" title={`${plural(toAttribute, "session")} not attributed yet`}>{toAttribute}</span>}
          </NavLink>
        ))}
      </div>
      <div className="nav-label">More</div>
      {OTHER.map((n) => (
        <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
          <n.icon size={17} strokeWidth={1.9} className="nav-icon" />
          {n.label}
        </NavLink>
      ))}
      <a className="nav-link" href="/claim" target="_blank" rel="noreferrer">
        <BadgeCheck size={17} strokeWidth={1.9} className="nav-icon" />
        Claim page
        <ExternalLink size={13} style={{ marginLeft: "auto", color: "var(--faint)" }} aria-label="opens in a new tab" />
      </a>
      <div className="sidebar-foot" style={{ marginTop: "auto" }}>
        <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
          {auth.user?.avatar_url ? <img src={auth.user.avatar_url} alt="" width={24} height={24} style={{ borderRadius: "50%" }} /> : hasToken ? <KeyRound size={14} color="var(--green)" /> : <Lock size={14} color="var(--faint)" />}
          <span style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{auth.user ? `@${auth.user.login}` : hasToken ? "Signed in with token" : "Read-only demo"}</span>
          <div className="spacer" />
          {(auth.user || hasToken)
            ? <button className="btn ghost sm" onClick={() => void auth.signOut()} aria-label="Sign out" title="Sign out"><LogOut size={14} /></button>
            : <Link className="btn ghost sm" to="/">Sign in</Link>}
        </div>
      </div>
    </aside>
  );
}

const THEMES: { v: ThemePref; icon: typeof Sun; label: string }[] = [
  { v: "light", icon: Sun, label: "Light" },
  { v: "system", icon: Monitor, label: "System" },
  { v: "dark", icon: Moon, label: "Dark" },
];

function TopBar({ onMenu, onSearch }: { onMenu: () => void; onSearch: () => void }) {
  const { data } = useOverview();
  const loc = useLocation();
  const [pref, setPref] = useThemePref();
  const f = data?.features;
  const next = THEMES[(THEMES.findIndex((t) => t.v === pref) + 1) % THEMES.length];
  const Current = THEMES.find((t) => t.v === pref)!.icon;
  return (
    <header className="topbar">
      <button className="btn ghost icon menu-btn" onClick={onMenu} aria-label="Open navigation"><Menu size={18} /></button>
      <div className="crumb">{titleFor(loc.pathname)}</div>
      <div className="spacer" />
      {f && !f.paypal && <span className="pill amber" title="Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET"><span className="dot" />PayPal keys missing</span>}
      <span className="env-chip" title="PayPal environment">
        <BrandIcon name="paypal" size={14} />
        {data?.environment === "sandbox" ? "PayPal test mode" : `PayPal ${data?.environment ?? "…"}`}
      </span>
      <span className="env-chip" title={f?.llm ? `Model ${data?.model}` : "Set MODEL_API_KEY to enable"}>
        <BrandIcon name="meta" size={14} />
        {f?.llm ? "Muse Spark on" : "Muse Spark off"}
      </span>
      <button className="search-trigger" onClick={onSearch} aria-label="Search and run commands">
        <Search size={15} />
        <span className="label">Search or jump to…</span>
        <span className="spacer" />
        <Kbd>Ctrl K</Kbd>
      </button>
      <button className="btn ghost icon" onClick={() => setPref(next.v)} aria-label={`Theme: ${pref}. Switch to ${next.label.toLowerCase()}`} title={`Theme: ${pref} (click for ${next.label.toLowerCase()})`}>
        <Current size={17} />
      </button>
    </header>
  );
}
