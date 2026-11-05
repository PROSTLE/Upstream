import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { siGithub, siNpm, siPypi, siClaude, siMeta } from "simple-icons";
import {
  AlertTriangle, BookOpen, Check, CheckCircle2, CircleDashed, Code2, Copy, Download, FileSearch, FileCode2, Globe, KeyRound, Loader2,
  PackagePlus, Search, Sparkles, Terminal, X, XCircle,
} from "lucide-react";
import { registerTokenPrompt, setAdminToken } from "./api.ts";


// ---------- brand ----------

export function Logo({ size = 30 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#2f5bea" />
          <stop offset="1" stopColor="#11a39c" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${CSS.escape(id)})`} />
      {/* Same geometry as scripts/icons.mjs, which renders the favicon and app icons. */}
      <g transform="translate(0 1.3)">
        <path d="M8 22c3.2-1.4 4.6-4.4 8-4.4s4.8 3 8 4.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" opacity=".55" />
        <path d="M8 16.5c3.2-1.4 4.6-4.4 8-4.4s4.8 3 8 4.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M16 6.5v5.6M13.3 9l2.7-2.7L18.7 9" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/**
 * PayPal's current mark, from PayPal's own files: paypalobjects.com/paypal-ui/logos/svg/paypal-mark-color.svg
 * and paypal-mark-monotone.svg (the monotone one is drawn in the text colour, keeping PayPal's opacities).
 */
export function PayPalMark({ size = 16, mono = false }: { size?: number; mono?: boolean }) {
  return mono ? (
    <svg width={size} height={size} viewBox="6 3 38 45" role="img" aria-label="PayPal" style={{ flex: "none" }}>
      <path fill="currentColor" fillRule="evenodd" opacity=".95" d="M38.168 13.352c-1.596-.842-3.535-1.346-5.644-1.346h-12.6l-4.218 26.92H6.413L12 3.032h15.05c5.065 0 9.056 2.827 10.518 6.755a9.643 9.643 0 0 1 .6 3.565Z" />
      <path fill="currentColor" opacity=".45" d="M43.527 23.671A12.848 12.848 0 0 1 30.814 34.44h-5.188L23.459 47.9h-9.235l1.482-8.973 1.747-11.148.363-2.312h7.468c7.753 0 12.884-6.562 12.884-12.114l.005.002c3.817 1.964 6.038 5.944 5.354 10.317Z" />
      <path fill="currentColor" opacity=".7" d="M38.167 13.352c-1.596-.841-3.534-1.346-5.644-1.346H19.924l-2.11 13.46h7.47c7.752 0 12.883-6.562 12.883-12.114Z" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="6 3 38 45" role="img" aria-label="PayPal" style={{ flex: "none" }}>
      <path fill="#002991" d="M38.914 13.35c0 5.574-5.144 12.15-12.927 12.15H18.49l-.368 2.322L16.373 39H7.056l5.605-36h15.095c5.083 0 9.082 2.833 10.555 6.77a9.687 9.687 0 0 1 .603 3.58z" />
      <path fill="#60CDFF" d="M44.284 23.7A12.894 12.894 0 0 1 31.53 34.5h-5.206L24.157 48H14.89l1.483-9 1.75-11.178.367-2.322h7.497c7.773 0 12.927-6.576 12.927-12.15 3.825 1.974 6.055 5.963 5.37 10.35z" />
      <path fill="#008CFF" d="M38.914 13.35C37.31 12.511 35.365 12 33.248 12h-12.64L18.49 25.5h7.497c7.773 0 12.927-6.576 12.927-12.15z" />
    </svg>
  );
}

const BRANDS = { npm: siNpm, pypi: siPypi, github: siGithub, claude: siClaude, meta: siMeta };
export function BrandIcon({ name, size = 16, mono = false }: { name: keyof typeof BRANDS | "paypal"; size?: number; mono?: boolean }) {
  if (name === "paypal") return <PayPalMark size={size} mono={mono} />;
  const icon = BRANDS[name];
  // GitHub's brand colour is near-black; draw it in the text colour so it stays visible in dark mode.
  const fill = mono || name === "github" ? "currentColor" : `#${icon.hex}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={icon.title} style={{ flex: "none" }}>
      <path d={icon.path} fill={fill} />
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

const TONE_COLOR: Record<string, string> = { green: "var(--green)", blue: "var(--accent)", violet: "var(--violet)", teal: "var(--teal)", amber: "var(--amber)" };
export function EvidenceIcon({ kind, size = 15 }: { kind: string; size?: number }) {
  const e = EVIDENCE[kind];
  const Icon = e?.icon ?? Sparkles;
  return <Icon size={size} color={TONE_COLOR[e?.tone ?? ""] ?? "var(--muted)"} aria-hidden />;
}

// ---------- status ----------

const STATUS: Record<string, string> = {
  open: "blue", closed: "", attributed: "teal",
  used: "green", consulted: "amber", present_only: "",
  draft: "amber", approved: "blue", sending: "blue", sent: "teal", held: "amber", failed: "red", empty: "",
  SUCCESS: "green", PENDING: "blue", PROCESSING: "blue", UNCLAIMED: "amber", ONHOLD: "amber", RETURNED: "violet",
  FAILED: "red", BLOCKED: "red", REFUNDED: "violet", REVERSED: "violet", DENIED: "red", CANCELED: "",
  ACTIVE: "green", APPROVAL_PENDING: "amber", APPROVED: "blue", SUSPENDED: "amber", CANCELLED: "", EXPIRED: "",
  verified: "green", pending: "amber", superseded: "", receiver_unclaimed: "amber", revoked: "red", none: "",
  reserved: "amber", in_batch: "blue", paid: "green", released: "", planned: "",
  meaningful: "green", supporting: "blue", incidental: "", not_used: "",
};
export function Status({ value, label, live }: { value: string | null | undefined; label?: string; live?: boolean }) {
  if (!value) return <span className="pill outline">—</span>;
  return (
    <span className={`pill ${STATUS[value] ?? ""}${live ? " live" : ""}`}>
      <span className="dot" />
      {label ?? (value === "attributed" ? "Reviewed" : value.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()))}
    </span>
  );
}

// ---------- layout bits ----------

export function PageHead({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow" style={{ marginBottom: 6 }}>{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Card({ title, sub, icon, tone, actions, children, pad = false, id }: {
  title?: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: string; actions?: ReactNode; children: ReactNode; pad?: boolean; id?: string;
}) {
  return (
    <section className="card" id={id}>
      {title && (
        <div className="card-head">
          {icon && <div className={`icon-tile ${tone ?? ""}`} aria-hidden>{icon}</div>}
          <div style={{ flex: "1 1 200px" }}>
            <h2>{title}</h2>
            {sub && <div className="sub">{sub}</div>}
          </div>
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
        <div className={`icon-tile ${tone ?? ""}`} style={{ width: 28, height: 28, borderRadius: 8 }} aria-hidden>{icon}</div>
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

/** Empty states say what belongs here and offer the one next step (NN/g's three jobs of an empty state). */
export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon-tile" aria-hidden>{icon}</div>
      <h3>{title}</h3>
      {children && <div className="body">{children}</div>}
      {action && <div className="row" style={{ marginTop: 6, justifyContent: "center" }}>{action}</div>}
    </div>
  );
}

export function Skeleton({ h = 14, w = "100%", r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skel" style={{ height: h, width: w, borderRadius: r }} aria-hidden />;
}

/** Placeholder with the page's rough shape, so content doesn't jump in. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" role="status" aria-label="Loading">
      <Skeleton h={30} w="38%" />
      <Skeleton h={14} w="62%" />
      <div className="grid-4" style={{ marginTop: 8 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} className="card stat"><Skeleton h={12} w="50%" /><Skeleton h={26} w="70%" /></div>)}
      </div>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="card card-pad stack"><Skeleton h={14} w="30%" /><Skeleton h={12} /><Skeleton h={12} w="80%" /></div>)}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-label="Loading" />;
}

export function ErrorBox({ error }: { error: string }) {
  return (
    <div className="callout red" role="alert">
      <XCircle size={18} color="var(--red)" />
      <div>{error}</div>
    </div>
  );
}

export function CheckRow({ ok, label, detail }: { ok: boolean | null; label: ReactNode; detail?: ReactNode }) {
  return (
    <div className="check">
      {ok === null ? <CircleDashed size={18} color="var(--faint)" aria-label="Not checked" /> : ok ? <CheckCircle2 size={18} color="var(--green)" aria-label="Passed" /> : <AlertTriangle size={18} color="var(--amber)" aria-label="Needs attention" />}
      <div>
        <div style={{ fontWeight: 560 }}>{label}</div>
        {detail && <div className="muted small">{detail}</div>}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Stepper({ steps, current, failed }: { steps: string[]; current: number; failed?: boolean }) {
  return (
    <ol className="stepper" aria-label="Progress" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? (failed ? "failed" : "current") : "";
        return (
          <li key={s} className="row" style={{ gap: 0, flexWrap: "nowrap" }}>
            {i > 0 && <span className={`line ${i <= current ? "done" : ""}`} aria-hidden />}
            <span className={`st ${state}`} aria-current={i === current ? "step" : undefined}>
              <span className={`step-dot ${state === "done" ? "done" : ""}`}>{state === "done" ? <Check size={12} strokeWidth={3} /> : state === "failed" ? <X size={12} strokeWidth={3} /> : i + 1}</span>
              {s}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function useCopy() {
  const toast = useToast();
  return useCallback(
    (text: string, what = "Copied") =>
      navigator.clipboard.writeText(text).then(
        () => toast(what),
        () => toast("Your browser blocked clipboard access. Select the text and copy it instead.", "error"),
      ),
    [toast],
  );
}

export function CopyButton({ text, label = "Copy", className = "btn sm", done = "Copied" }: { text: string; label?: string; className?: string; done?: string }) {
  const copy = useCopy();
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={() => copy(text, done).then(() => { setOk(true); setTimeout(() => setOk(false), 1600); })}
    >
      {ok ? <Check size={13} /> : <Copy size={13} />}
      {label}
    </button>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <div className="code-wrap">
      <pre className="codeblock">{children}</pre>
      <CopyButton text={children} className="btn sm copy" />
    </div>
  );
}

// ---------- overlays ----------

function useEscape(onClose: () => void) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
}

export function Modal({ title, sub, icon, tone, onClose, children, foot, width = 480 }: {
  title: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: string; onClose: () => void; children: ReactNode; foot?: ReactNode; width?: number;
}) {
  useEscape(onClose);
  const titleId = useId();
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div className="card-head" style={{ flexWrap: "nowrap" }}>
          {icon && <div className={`icon-tile ${tone ?? ""}`} aria-hidden>{icon}</div>}
          <div>
            <h2 id={titleId}>{title}</h2>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <div className="spacer" />
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="card-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, sub, onClose, children }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <>
      <div className="drawer-back" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <div className="card-head" style={{ flexWrap: "nowrap" }}>
          <div>
            <h2 id={titleId}>{title}</h2>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <div className="spacer" />
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  /** Name the action and the amount, e.g. "Send $42.10 to 3 maintainers". */
  confirmLabel: ReactNode;
  tone?: "primary" | "danger" | "paypal";
  icon?: ReactNode;
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => true);
export const useConfirm = () => useContext(ConfirmCtx);

// ---------- action button with spinner + toast on error ----------

export function ActionButton({ onRun, children, className = "btn", disabled, title, confirm }: {
  onRun: () => Promise<unknown>; children: ReactNode; className?: string; disabled?: boolean; title?: string; confirm?: ConfirmOptions;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const ask = useConfirm();
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy}
      title={title}
      aria-busy={busy || undefined}
      onClick={async () => {
        if (confirm && !(await ask(confirm))) return;
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
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 4500);
  }, []);

  const [prompt, setPrompt] = useState<((v: string | null) => void) | null>(null);
  useEffect(() => {
    registerTokenPrompt(() => new Promise((resolve) => setPrompt(() => resolve)));
  }, []);

  const [confirm, setConfirm] = useState<{ o: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirm({ o, resolve })), []);
  const settle = (v: boolean) => {
    confirm?.resolve(v);
    setConfirm(null);
  };

  return (
    <ToastCtx.Provider value={push}>
      <ConfirmCtx.Provider value={ask}>
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
        {confirm && (
          <Modal
            title={confirm.o.title}
            icon={confirm.o.icon}
            tone={confirm.o.tone === "danger" ? "red" : "green"}
            onClose={() => settle(false)}
            foot={
              <>
                <button className="btn ghost" onClick={() => settle(false)}>Cancel</button>
                <button
                  className={`btn ${confirm.o.tone === "danger" ? "danger-solid" : confirm.o.tone === "paypal" ? "paypal" : "primary"}`}
                  autoFocus
                  onClick={() => settle(true)}
                >
                  {confirm.o.confirmLabel}
                </button>
              </>
            }
          >
            {confirm.o.body}
          </Modal>
        )}
        <div className="toast-wrap" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.kind === "error" ? <AlertTriangle size={16} style={{ flex: "none" }} /> : <CheckCircle2 size={16} style={{ flex: "none" }} />}
              <div style={{ flex: 1 }}>{t.text}</div>
              <button className="btn ghost sm icon" style={{ color: "inherit", minHeight: 22, width: 22 }} aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}><X size={13} /></button>
            </div>
          ))}
        </div>
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}

function TokenModal({ onDone }: { onDone: (v: string | null) => void }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal title="Unlock admin actions" sub="Actions that move money or change records need the server's ADMIN_TOKEN." icon={<KeyRound size={17} />} onClose={() => onDone(null)}>
      <form
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          onDone(v.trim() || null);
        }}
      >
        <div className="field">
          <label htmlFor="admin-token">Admin token</label>
          <input id="admin-token" ref={ref} className="input mono" type="password" autoComplete="off" placeholder="Paste ADMIN_TOKEN" value={v} onChange={(e) => setV(e.target.value)} />
          <span className="hint">Kept in this browser only. Lock again any time from the sidebar.</span>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={() => onDone(null)}>Cancel</button>
          <button className="btn primary" type="submit" disabled={!v.trim()}>Unlock</button>
        </div>
      </form>
    </Modal>
  );
}
