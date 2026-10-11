import { lazy, Suspense, useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  ArrowLeftRight, BadgeCheck, Boxes, FlaskConical, KeyRound, LayoutDashboard, LogOut, PlugZap, Send, TerminalSquare, Wallet,
} from "lucide-react";
import { getAdminToken, setAdminToken, useApi } from "./api.ts";
import { BrandIcon, Loading, Logo } from "./ui.tsx";
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

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/funding", label: "Funding", icon: Wallet },
  { to: "/sessions", label: "Agent sessions", icon: TerminalSquare },
  { to: "/packages", label: "Packages & maintainers", icon: Boxes },
  { to: "/settlements", label: "Payouts", icon: Send },
  { to: "/ledger", label: "Ledger", icon: ArrowLeftRight },
  { to: "/eval", label: "Attribution eval", icon: FlaskConical },
];

export function App() {
  const loc = useLocation();
  const isPublic = loc.pathname.startsWith("/claim") || loc.pathname.startsWith("/c/");
  if (isPublic) {
    return (
      <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/claim" element={<Claim />} />
        <Route path="/claim/complete" element={<ClaimComplete />} />
        <Route path="/c/:token" element={<PublicClaim />} />
      </Routes>
      </Suspense>
    );
  }
  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <TopBar />
        <Suspense fallback={<div className="page"><Loading /></div>}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/funding" element={<Funding />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/packages" element={<Packages />} />
          <Route path="/settlements" element={<Settlements />} />
          <Route path="/settlements/:id" element={<SettlementDetail />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/eval" element={<Eval />} />
          <Route path="/connect" element={<Connect />} />
        </Routes>
        </Suspense>
      </div>
    </div>
  );
}

function Sidebar() {
  const [hasToken, setHasToken] = useState(Boolean(getAdminToken()));
  useEffect(() => {
    const f = () => setHasToken(Boolean(getAdminToken()));
    window.addEventListener("upstream:token", f);
    return () => window.removeEventListener("upstream:token", f);
  }, []);
  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo />
        <div>
          <div className="brand-name">Upstream</div>
          <div className="brand-sub">Agent-funded open source</div>
        </div>
      </div>
      <div className="nav-label">Funder</div>
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
          <n.icon size={17} strokeWidth={1.9} />
          {n.label}
        </NavLink>
      ))}
      <div className="nav-label">Setup</div>
      <NavLink to="/connect" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
        <PlugZap size={17} strokeWidth={1.9} />
        Connect your agent
      </NavLink>
      <a className="nav-link" href="/claim" target="_blank" rel="noreferrer">
        <BadgeCheck size={17} strokeWidth={1.9} />
        Maintainer claim page
      </a>
      <div className="sidebar-foot">
        <div className="row" style={{ gap: 8 }}>
          <KeyRound size={14} color={hasToken ? "var(--green)" : "var(--faint)"} />
          <span style={{ fontWeight: 560 }}>{hasToken ? "Admin unlocked" : "Read-only"}</span>
          <div className="spacer" />
          {hasToken && (
            <button className="btn ghost sm" title="Forget admin token" onClick={() => setAdminToken(null)}>
              <LogOut size={14} />
            </button>
          )}
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          {hasToken ? "Money actions are enabled in this browser." : "You'll be asked for the admin token when you act."}
        </div>
      </div>
    </aside>
  );
}

function TopBar() {
  const { data } = useApi<any>("/api/health");
  const live = data?.features;
  return (
    <div className="topbar">
      <span className="env-chip">
        <BrandIcon name="paypal" size={14} />
        PayPal {data?.paypal_env ?? "…"}
      </span>
      <span className="env-chip">
        <BrandIcon name="claude" size={14} />
        {live?.llm ? "Claude attribution on" : "Claude attribution off"}
      </span>
      <div className="spacer" />
      {live && !live.paypal && <span className="pill amber"><span className="dot" />PayPal keys missing</span>}
      {live && !live.ingest && <span className="pill amber"><span className="dot" />Ingest token missing</span>}
    </div>
  );
}
