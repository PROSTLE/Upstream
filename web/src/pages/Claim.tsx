import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, BadgeCheck, CheckCircle2, FileCode2, HandCoins, HeartHandshake, Mail, ShieldCheck, XCircle } from "lucide-react";
import { api, useApi } from "../api.ts";
import { dateTime, moneyStr, plural } from "../format.ts";
import { ActionButton, BrandIcon, Card, CodeBlock, ErrorBox, Logo, Skeleton, Status, Stepper } from "../ui.tsx";
import { useBrand, useHealth } from "../brand.tsx";

export function PublicShell({ children, wide, to = "/claim", tagline = "Get paid when AI coding agents rely on your work" }: { children: ReactNode; wide?: boolean; to?: string; tagline?: string }) {
  const brand = useBrand();
  return (
    <div className="public-wrap">
      <div className={`public-card${wide ? " wide" : ""}`}>
        <Link to={to} className="hero-mark">
          <Logo size={36} />
          <div>
            <div className="brand-name" style={{ fontSize: 20 }}>{brand || <Skeleton h={20} w={100} />}</div>
            <div className="brand-sub">{tagline}</div>
          </div>
        </Link>
        {children}
      </div>
    </div>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** owner/name, or any github.com URL that contains one. */
export function repoSlug(input: string): string | null {
  const m = input.trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

function EmailField({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const [touched, setTouched] = useState(false);
  const bad = touched && value.length > 0 && !EMAIL.test(value);
  return (
    <div className="field">
      <label htmlFor={id}>PayPal account email</label>
      <input id={id} className="input" type="email" autoComplete="email" placeholder="you@example.com" value={value} aria-invalid={bad} aria-describedby={`${id}-hint`} onBlur={() => setTouched(true)} onChange={(e) => onChange(e.target.value)} />
      {bad ? <span className="err" id={`${id}-hint`}>That doesn't look like an email address.</span> : <span className="hint" id={`${id}-hint`}>The email of the PayPal account that should receive payouts. It is never shown publicly.</span>}
    </div>
  );
}

export function Claim() {
  const [params] = useSearchParams();
  const health = { data: useHealth() };
  const waiting = useApi<any[]>("/api/public/repos");
  const [repo, setRepo] = useState(params.get("repo") ?? "");
  const [touched, setTouched] = useState(Boolean(params.get("repo")));
  const [method, setMethod] = useState<"github" | "funding">("github");
  const [receiver, setReceiver] = useState("");
  const [started, setStarted] = useState<any>(null);
  const [verified, setVerified] = useState<any>(null);
  const [held, setHeld] = useState<any>(null);
  const slug = repoSlug(repo);
  const oauth = health.data?.features?.githubOAuth;
  const ppLogin = Boolean(health.data?.features?.paypalLogin);
  const fundingId = params.get("funding");
  useEffect(() => {
    // Back from Log in with PayPal: the FUNDING.yml claim was created with the PayPal-verified email.
    if (!fundingId) return;
    api<any>(`/api/claims/funding/${encodeURIComponent(fundingId)}`).then((v) => {
      setMethod("funding");
      setRepo(v.repo.replace("github.com/", ""));
      setStarted(v);
      if (v.status === "verified") setVerified(v);
    }, () => {});
  }, [fundingId]);
  useEffect(() => {
    if (health.data && oauth === false) setMethod("funding");
  }, [health.data, oauth]);
  useEffect(() => {
    setHeld(null);
    if (!slug) return;
    const t = setTimeout(() => api(`/api/public/repos/${slug}`).then(setHeld, () => setHeld(null)), 250);
    return () => clearTimeout(t);
  }, [slug]);
  const step = verified ? 3 : started ? 2 : slug ? 1 : 0;
  const open = (waiting.data ?? []).filter((r) => r.held_minor > 0 && r.claim.status !== "verified");

  return (
    <PublicShell>
      <Card pad>
        <div className="row" style={{ gap: 12, marginBottom: 18, flexWrap: "nowrap", alignItems: "flex-start" }}>
          <div className="icon-tile teal" style={{ width: 42, height: 42 }}><HeartHandshake size={20} /></div>
          <div>
            <h1 style={{ fontSize: 22 }}>Claim your project</h1>
            <p className="muted">Prove you maintain the repository, then tell us where PayPal should send payouts. Takes about two minutes.</p>
          </div>
        </div>
        <div style={{ marginBottom: 20 }}><Stepper steps={["Repository", "Prove you maintain it", "Payout account"]} current={step} /></div>
        {params.get("error") && <div style={{ marginBottom: 14 }}><ErrorBox error={params.get("error")!} /></div>}

        <div className="field" style={{ marginBottom: 12 }}>
          <label htmlFor="repo">GitHub repository</label>
          <input
            id="repo"
            className="input"
            placeholder="owner/name or https://github.com/owner/name"
            value={repo}
            disabled={Boolean(started)}
            aria-invalid={touched && repo.length > 0 && !slug}
            onBlur={() => setTouched(true)}
            onChange={(e) => setRepo(e.target.value)}
          />
          {touched && repo.length > 0 && !slug && <span className="err">Use the form owner/name, for example colinhacks/zod.</span>}
        </div>
        {held && (
          <div className={`callout ${held.held_minor > 0 ? "amber" : "blue"}`} style={{ marginBottom: 16 }}>
            <HandCoins size={18} color={held.held_minor > 0 ? "var(--amber)" : "var(--accent)"} />
            <div className="small">
              {held.held_minor > 0
                ? <><strong>{moneyStr(held.held, held.currency)} is waiting</strong> for this repo from {plural(held.sessions_relied, "agent session")}. It's held until a maintainer verifies.</>
                : <>Agents relied on this repo in <strong>{plural(held.sessions_relied, "session")}</strong>.</>}
              {held.claim.status === "verified" && <> A maintainer has already verified it; a new verified claim replaces theirs.</>}
            </div>
          </div>
        )}

        {!started && (
          <>
            <div className="field" style={{ marginBottom: 10 }}><label>How do you want to prove it?</label></div>
            <div className="grid-2" style={{ gap: 10, marginBottom: 16 }} role="radiogroup" aria-label="Verification method">
              <MethodCard active={method === "github"} disabled={oauth === false} onClick={() => setMethod("github")} icon={<BrandIcon name="github" size={18} />} title="Sign in with GitHub" note={oauth === false ? "Not configured on this server" : "Fastest. Needs admin or maintain access."} />
              <MethodCard active={method === "funding"} onClick={() => setMethod("funding")} icon={<FileCode2 size={18} />} title="Commit a FUNDING.yml line" note="No sign-in. Needs push access to the default branch." />
            </div>
          </>
        )}

        {method === "github" && !started ? (
          <>
            <p className="small muted" style={{ marginBottom: 14 }}>
              GitHub tells us your permission on this repository. We accept the claim only if you're an <strong>admin or maintainer</strong>, and we never get write access.
            </p>
            <a className="btn dark lg" href={slug ? `/api/claims/github/start?repo=${encodeURIComponent(slug)}` : undefined} aria-disabled={!slug}>
              <BrandIcon name="github" size={16} mono />
              Continue with GitHub
              <ArrowRight size={16} />
            </a>
          </>
        ) : !started ? (
          <>
            {ppLogin && (
              <div className="stack" style={{ gap: 8, marginBottom: 14 }}>
                <a className="btn paypal lg" href={slug ? `/api/claims/paypal/start?repo=${encodeURIComponent(slug)}` : undefined} aria-disabled={!slug}>
                  <BrandIcon name="paypal" size={16} mono />Use my PayPal account
                </a>
                <span className="hint small muted">Recommended: payouts go to the email PayPal has verified for you, so a typo can't send money to the wrong place.</span>
                <div className="row muted small" style={{ gap: 10 }}><span className="divider" style={{ flex: 1 }} />or type it<span className="divider" style={{ flex: 1 }} /></div>
              </div>
            )}
            <div style={{ marginBottom: 14 }}><EmailField id="recv" value={receiver} onChange={setReceiver} /></div>
            <ActionButton className="btn primary lg" disabled={!slug || !EMAIL.test(receiver)} onRun={async () => setStarted(await api("/api/claims/funding-token", { body: { repo: slug, receiver } }))}>
              <FileCode2 size={15} />Get my FUNDING.yml line
            </ActionButton>
          </>
        ) : verified ? (
          <Verified repo={verified.repo} />
        ) : (
          <div className="stack">
            {started.receiver && (
              <div className="callout green"><CheckCircle2 size={16} color="var(--green)" /><div className="small">Payouts will go to <strong>{started.receiver}</strong>{started.receiver_verified_by_paypal ? ", verified by PayPal." : "."}</div></div>
            )}
            <p className="small">Add this line to <code>.github/FUNDING.yml</code> in <strong>{started.repo.replace("github.com/", "")}</strong> and commit it to the default branch. If the file already has a <code>custom</code> entry, add the URL to that list instead of a second <code>custom:</code> line (GitHub allows up to four <code>custom</code> links). Then verify:</p>
            <CodeBlock>{started.instruction}</CodeBlock>
            <div className="row">
              <ActionButton className="btn primary" onRun={async () => setVerified(await api(`/api/claims/${started.id}/verify`, { body: {} }))}>
                <ShieldCheck size={15} />I've committed it, verify now
              </ActionButton>
              <span className="muted small">The link is public by design: it reveals nothing about your payout email, and can't be used to change it.</span>
            </div>
          </div>
        )}
      </Card>

      {open.length > 0 && !started && (
        <Card title="Money waiting for maintainers" sub="Held for these repos until someone verifies. Is one of them yours?" icon={<HandCoins size={17} />} tone="amber">
          <div className="list flush">
            {open.slice(0, 8).map((r) => (
              <div key={r.repo} className="list-item">
                <BrandIcon name="github" size={15} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{r.repo.replace("github.com/", "")}</strong>
                  <div className="muted small">Relied on in {plural(r.sessions_relied, "agent session")}</div>
                </div>
                <span className="num" style={{ fontWeight: 650, color: "var(--amber)" }}>{moneyStr(r.held, r.currency)}</span>
                <button className="btn sm" onClick={() => { setRepo(r.repo.replace("github.com/", "")); setTouched(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Claim</button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <p className="muted small" style={{ textAlign: "center" }}>
        Payouts are sent with PayPal Payouts. Unclaimed payouts are cancelled after a policy period and held for you; if nobody claims a repo, its share returns to the funder's pool.
      </p>
    </PublicShell>
  );
}

function MethodCard({ active, disabled, onClick, icon, title, note }: { active: boolean; disabled?: boolean; onClick: () => void; icon: ReactNode; title: string; note: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className="card"
      style={{
        textAlign: "left", padding: 14, cursor: disabled ? "not-allowed" : "pointer", font: "inherit", color: "inherit", opacity: disabled ? 0.55 : 1,
        borderColor: active ? "var(--accent)" : undefined, boxShadow: active ? "var(--ring)" : undefined, background: active ? "var(--accent-soft)" : undefined,
      }}
    >
      <div className="row" style={{ gap: 8, fontWeight: 600 }}>{icon}{title}</div>
      <div className="muted small" style={{ marginTop: 4 }}>{note}</div>
    </button>
  );
}

function Verified({ repo }: { repo: string }) {
  const slug = repo.replace("github.com/", "");
  return (
    <div className="stack">
      <div className="callout green"><CheckCircle2 size={18} color="var(--green)" /><div><strong>{slug}</strong> is verified and payable. Future payouts for it go to your PayPal account.</div></div>
      <Link className="btn" to={`/r/${slug}`}>See your repo page and README badge <ArrowRight size={15} /></Link>
    </div>
  );
}

export function ClaimComplete() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const doneRepo = params.get("done");
  const repo = params.get("repo") ?? doneRepo ?? "";
  const [receiver, setReceiver] = useState("");
  const [done, setDone] = useState<any>(doneRepo ? { repo: doneRepo } : null);
  const ppLogin = Boolean(useHealth().features?.paypalLogin);
  return (
    <PublicShell>
      <Card pad>
        <div className="row" style={{ gap: 12, marginBottom: 18, flexWrap: "nowrap", alignItems: "flex-start" }}>
          <div className="icon-tile green" style={{ width: 42, height: 42 }}><BadgeCheck size={20} /></div>
          <div>
            <h1 style={{ fontSize: 22 }}>GitHub confirmed you maintain {repo.replace("github.com/", "")}</h1>
            <p className="muted">Last step: where should PayPal send your payouts?</p>
          </div>
        </div>
        <div style={{ marginBottom: 20 }}><Stepper steps={["Repository", "Prove you maintain it", "Payout account"]} current={done ? 3 : 2} /></div>
        {params.get("error") && <div style={{ marginBottom: 14 }}><ErrorBox error={params.get("error")!} /></div>}
        {done ? (
          <>
            {params.get("via") === "paypal" && <p className="small muted" style={{ marginBottom: 10 }}>Your payout email came from PayPal and is verified there.</p>}
            <Verified repo={done.repo} />
          </>
        ) : (
          <>
            {ppLogin && token && (
              <div className="stack" style={{ gap: 8, marginBottom: 14 }}>
                <a className="btn paypal lg" href={`/api/claims/paypal/start?token=${encodeURIComponent(token)}`}>
                  <BrandIcon name="paypal" size={16} mono />Connect my PayPal account
                </a>
                <span className="hint small muted">Recommended: we use the email PayPal has verified for you. We don't keep your PayPal sign-in.</span>
                <div className="row muted small" style={{ gap: 10 }}><span className="divider" style={{ flex: 1 }} />or type it<span className="divider" style={{ flex: 1 }} /></div>
              </div>
            )}
            <div style={{ marginBottom: 14 }}><EmailField id="recv2" value={receiver} onChange={setReceiver} /></div>
            <ActionButton className="btn primary lg" disabled={!EMAIL.test(receiver) || !token} onRun={async () => setDone(await api("/api/claims/complete", { body: { token, receiver } }))}>
              <Mail size={15} />Save payout account
            </ActionButton>
          </>
        )}
      </Card>
    </PublicShell>
  );
}

export function PublicClaim() {
  const { token = "" } = useParams();
  const { data, error } = useApi<any>(`/api/claims/public/${encodeURIComponent(token)}`, [token]);
  return (
    <PublicShell>
      <Card pad>
        {error ? (
          <div className="row"><XCircle color="var(--red)" />{error}</div>
        ) : !data ? null : (
          <div className="stack">
            <div className="row" style={{ gap: 10 }}>
              <BrandIcon name="github" size={20} />
              <h1 style={{ fontSize: 20 }}>{data.repo.replace("github.com/", "")}</h1>
              <Status value={data.status} />
            </div>
            <p className="muted">
              This repository {data.status === "verified" ? "receives" : "is setting up"} {data.brand} payouts: when AI coding agents rely on it, their users' open-source budgets are shared with its maintainers through PayPal.
            </p>
            <div className="muted small">Claim started {dateTime(data.created_at)}{data.verified_at ? ` · verified ${dateTime(data.verified_at)}` : ""}</div>
            <Link className="btn" to={`/r/${data.repo.replace("github.com/", "")}`}>Open the repo page <ArrowRight size={15} /></Link>
          </div>
        )}
      </Card>
    </PublicShell>
  );
}
