import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { siGithub, siNpm, siPaypal, siPypi, siClaude } from "simple-icons";
import {
  AlertTriangle, BookOpen, CheckCircle2, CircleDashed, Code2, Download, FileSearch, FileCode2, Globe, KeyRound, Loader2,
  PackagePlus, Search, Sparkles, Terminal, X, XCircle,
} from "lucide-react";
import { registerTokenPrompt, setAdminToken } from "./api.ts";


// ---------- brand ----------

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="up-g" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#2f5bea" />
          <stop offset="1" stopColor="#11a39c" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#up-g)" />
      <path d="M8 22c3.2-1.4 4.6-4.4 8-4.4s4.8 3 8 4.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" opacity=".55" />
      <path d="M8 16.5c3.2-1.4 4.6-4.4 8-4.4s4.8 3 8 4.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M16 6.5v5.6M13.3 9l2.7-2.7L18.7 9" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const BRANDS = { npm: siNpm, pypi: siPypi, github: siGithub, paypal: siPaypal, claude: siClaude };
export function BrandIcon({ name, size = 16, mono = false }: { name: keyof typeof BRANDS; size?: number; mono?: boolean }) {
  const icon = BRANDS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={icon.title} style={{ flex: "none" }}>
      <path d={icon.path} fill={mono ? "currentColor" : `#${icon.hex}`} />
    </svg>
  );
}

export function EcoIcon({ ecosystem, size = 16 }: { ecosystem: string; size?: number }) {
  if (ecosystem === "npm") return <BrandIcon name="npm" size={size} />;
  if (ecosystem === "pypi") return <BrandIcon name="pypi" size={size} />;
  return <Code2 size={size} />;
}

export function PackageChip({ ecosystem, name, weight }: { ecosystem: string; name: string; weight?: number }) {
  return (
    <span className="chip">
      <EcoIcon ecosystem={ecosystem} size={13} />
      <span>{name}</span>
      {weight != null && <span className="num faint">{Math.round(weight * 100)}%</span>}
    </span>
  );
}

// ---------- evidence kinds ----------

export const EVIDENCE: Record<string, { label: string; icon: typeof Code2; tone: string }> = {
  dep_install: { label: "Installed", icon: Download, tone: "green" },
  manifest_add: { label: "Added to manifest", icon: PackagePlus, tone: "green" },
  import_added: { label: "Import written", icon: FileCode2, tone: "blue" },
  api_usage: { label: "API used in new code", icon: Code2, tone: "blue" },
  cli_run: { label: "CLI run", icon: Terminal, tone: "violet" },
  source_read: { label: "Read library source", icon: FileSearch, tone: "teal" },
  source_search: { label: "Searched library source", icon: Search, tone: "teal" },
  docs_fetch: { label: "Read docs", icon: Globe, tone: "amber" },
  docs_mcp: { label: "Docs via MCP", icon: BookOpen, tone: "amber" },
  web_search: { label: "Web search", icon: Search, tone: "" },
};

export function EvidenceIcon({ kind, size = 15 }: { kind: string; size?: number }) {
  const e = EVIDENCE[kind];
  const Icon = e?.icon ?? Sparkles;
  const colors: Record<string, string> = { green: "var(--green)", blue: "var(--accent)", violet: "var(--violet)", teal: "var(--teal)", amber: "var(--amber)" };
  return <Icon size={size} color={colors[e?.tone ?? ""] ?? "var(--muted)"} />;
}

// ---------- status ----------

const STATUS: Record<string, string> = {
  open: "blue", closed: "", attributed: "teal",
  used: "green", consulted: "amber", present_only: "",
  draft: "amber", approved: "blue", sending: "blue", sent: "teal", failed: "red", empty: "",
  SUCCESS: "green", PENDING: "blue", PROCESSING: "blue", UNCLAIMED: "amber", ONHOLD: "amber", RETURNED: "violet",
  FAILED: "red", BLOCKED: "red", REFUNDED: "violet", REVERSED: "violet", DENIED: "red", CANCELED: "",
  ACTIVE: "green", APPROVAL_PENDING: "amber", APPROVED: "blue", SUSPENDED: "amber", CANCELLED: "", EXPIRED: "",
  verified: "green", pending: "amber", superseded: "", receiver_unclaimed: "amber", revoked: "red",
  reserved: "amber", in_batch: "blue", paid: "green", released: "", planned: "",
  meaningful: "green", supporting: "blue", incidental: "", not_used: "",
};
export function Status({ value, label }: { value: string | null | undefined; label?: string }) {
  if (!value) return <span className="pill outline">—</span>;
  return (
    <span className={`pill ${STATUS[value] ?? ""}`}>
      <span className="dot" />
      {label ?? value.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
    </span>
  );
}

// ---------- layout bits ----------

export function PageHead({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Card({ title, sub, icon, tone, actions, children, pad = false }: {
  title?: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: string; actions?: ReactNode; children: ReactNode; pad?: boolean;
}) {
  return (
    <section className="card">
      {title && (
        <div className="card-head">
          {icon && <div className={`icon-tile ${tone ?? ""}`}>{icon}</div>}
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <div className="spacer" />
          {actions}
        </div>
      )}
      <div className={pad ? "card-pad" : title ? "card-body" : ""}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, currency, foot, icon, tone }: { label: string; value: ReactNode; currency?: string; foot?: ReactNode; icon: ReactNode; tone?: string }) {
  return (
    <div className="card stat">
      <div className="stat-label">
        <div className={`icon-tile ${tone ?? ""}`} style={{ width: 28, height: 28, borderRadius: 8 }}>{icon}</div>
        {label}
      </div>
      <div className="stat-value">
        {value}
        {currency && <span className="cur">{currency}</span>}
      </div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon-tile">{icon}</div>
      <h3 style={{ color: "var(--text)" }}>{title}</h3>
      {children && <div style={{ maxWidth: 460 }}>{children}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <div className="empty">
      <Loader2 className="spin" style={{ animation: "spin .9s linear infinite" }} />
    </div>
  );
}

export function ErrorBox({ error }: { error: string }) {
  return (
    <div className="callout red">
      <XCircle size={18} color="var(--red)" style={{ flex: "none", marginTop: 1 }} />
      <div>{error}</div>
    </div>
  );
}

export function CheckRow({ ok, label, detail }: { ok: boolean | null; label: ReactNode; detail?: ReactNode }) {
  return (
    <div className="check">
      {ok === null ? <CircleDashed size={18} color="var(--faint)" /> : ok ? <CheckCircle2 size={18} color="var(--green)" /> : <AlertTriangle size={18} color="var(--amber)" />}
      <div>
        <div style={{ fontWeight: 560 }}>{label}</div>
        {detail && <div className="muted small">{detail}</div>}
      </div>
    </div>
  );
}

// ---------- action button with spinner + toast on error ----------

export function ActionButton({ onRun, children, className = "btn", disabled, title }: {
  onRun: () => Promise<unknown>; children: ReactNode; className?: string; disabled?: boolean; title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button
      className={className}
      disabled={disabled || busy}
      title={title}
      onClick={async () => {
        setBusy(true);
        try {
          await onRun();
        } catch (e) {
          toast((e as Error).message, "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy && <Loader2 size={15} className="spin" />}
      {children}
    </button>
  );
}

// ---------- toasts ----------

type Toast = { id: number; text: string; kind: "info" | "error" };
const ToastCtx = createContext<(text: string, kind?: "info" | "error") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function Providers({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: "info" | "error" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);

  const [prompt, setPrompt] = useState<((v: string | null) => void) | null>(null);
  useEffect(() => {
    registerTokenPrompt(() => new Promise((resolve) => setPrompt(() => resolve)));
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {prompt && (
        <TokenModal
          onDone={(v) => {
            if (v) setAdminToken(v);
            prompt(v);
            setPrompt(null);
          }}
        />
      )}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <div style={{ flex: 1 }}>{t.text}</div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function TokenModal({ onDone }: { onDone: (v: string | null) => void }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="modal-back" onClick={() => onDone(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="icon-tile"><KeyRound size={17} /></div>
          <div>
            <h2>Admin token</h2>
            <div className="sub">Actions that move money or change records need the server's ADMIN_TOKEN.</div>
          </div>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => onDone(null)} aria-label="Close"><X size={16} /></button>
        </div>
        <form
          className="card-body"
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            onDone(v.trim() || null);
          }}
        >
          <input ref={ref} className="input mono" type="password" placeholder="Paste ADMIN_TOKEN" value={v} onChange={(e) => setV(e.target.value)} />
          <div className="muted small">Kept in this browser only. Clear it any time from the sidebar.</div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost" onClick={() => onDone(null)}>Cancel</button>
            <button className="btn primary" type="submit">Continue</button>
          </div>
        </form>
      </div>
    </div>
  );
}

