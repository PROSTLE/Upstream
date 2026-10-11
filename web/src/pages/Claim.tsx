import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { BadgeCheck, CheckCircle2, FileCode2, HeartHandshake, Mail, ShieldCheck, XCircle } from "lucide-react";
import { api, useApi } from "../api.ts";
import { dateTime } from "../format.ts";
import { ActionButton, BrandIcon, Card, ErrorBox, Logo, Status } from "../ui.tsx";

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-wrap">
      <div className="public-card">
        <div className="hero-mark">
          <Logo size={36} />
          <div>
            <div className="brand-name" style={{ fontSize: 20 }}>Upstream</div>
            <div className="brand-sub">Get paid when AI coding agents rely on your work</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Claim() {
  const [params] = useSearchParams();
  const [repo, setRepo] = useState(params.get("repo") ?? "");
  const [method, setMethod] = useState<"github" | "funding">("github");
  const [receiver, setReceiver] = useState("");
  const [started, setStarted] = useState<any>(null);
  const [verified, setVerified] = useState<any>(null);

  return (
    <PublicShell>
      <Card pad>
        <div className="row" style={{ gap: 12, marginBottom: 18, flexWrap: "nowrap" }}>
          <div className="icon-tile teal" style={{ width: 42, height: 42 }}><HeartHandshake size={20} /></div>
          <div>
            <h1 style={{ fontSize: 22 }}>Claim your project</h1>
            <p className="muted">Prove you maintain the repository, then tell us where PayPal should send payouts.</p>
          </div>
        </div>
        {params.get("error") && <div style={{ marginBottom: 14 }}><ErrorBox error={params.get("error")!} /></div>}

        <div className="field" style={{ marginBottom: 14 }}>
          <label>GitHub repository</label>
          <input className="input" placeholder="owner/name or https://github.com/owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} />
        </div>

        <div className="tabs" style={{ marginBottom: 16 }}>
          <button className={`tab ${method === "github" ? "active" : ""}`} onClick={() => setMethod("github")}>Sign in with GitHub</button>
          <button className={`tab ${method === "funding" ? "active" : ""}`} onClick={() => setMethod("funding")}>FUNDING.yml token</button>
        </div>

        {method === "github" ? (
          <>
            <p className="small muted" style={{ marginBottom: 14 }}>
              We ask GitHub for your permissions on this repository and accept the claim only if you are an <strong>admin or maintainer</strong>. We never get write access.
            </p>
            <a className={`btn dark ${!repo ? "disabled" : ""}`} href={repo ? `/api/claims/github/start?repo=${encodeURIComponent(repo)}` : undefined} aria-disabled={!repo} style={{ pointerEvents: repo ? undefined : "none", opacity: repo ? 1 : 0.5 }}>
              <BrandIcon name="github" size={16} mono />
              Continue with GitHub
            </a>
          </>
        ) : !started ? (
          <>
            <p className="small muted" style={{ marginBottom: 14 }}>No GitHub sign-in needed: we give you a link to add to your repo's FUNDING.yml. Committing it proves you can write to the default branch.</p>
            <div className="field" style={{ marginBottom: 14 }}>
              <label>PayPal account email</label>
              <input className="input" type="email" placeholder="you@example.com" value={receiver} onChange={(e) => setReceiver(e.target.value)} />
            </div>
            <ActionButton className="btn primary" disabled={!repo || !receiver} onRun={async () => setStarted(await api("/api/claims/funding-token", { body: { repo, receiver } }))}>
              <FileCode2 size={15} />Get my FUNDING.yml line
            </ActionButton>
          </>
        ) : verified ? (
          <div className="callout green"><CheckCircle2 size={18} color="var(--green)" /><div><strong>{verified.repo}</strong> is verified. Future Upstream payouts for it go to your PayPal account.</div></div>
        ) : (
          <>
            <p className="small" style={{ marginBottom: 8 }}>Add this line to <code>.github/FUNDING.yml</code> in <strong>{started.repo}</strong> (GitHub allows up to four <code>custom</code> links), commit it to the default branch, then verify:</p>
            <pre className="codeblock">{started.instruction}</pre>
            <div className="row" style={{ marginTop: 14 }}>
              <ActionButton className="btn primary" onRun={async () => setVerified(await api(`/api/claims/${started.id}/verify`, { body: {} }))}>
                <ShieldCheck size={15} />Verify now
              </ActionButton>
              <span className="muted small">This link is public by design; it reveals nothing about your payout email.</span>
            </div>
          </>
        )}
      </Card>
      <p className="muted small" style={{ textAlign: "center", marginTop: 16 }}>
        Payouts are sent with PayPal Payouts. Unclaimed payouts are cancelled after a policy period and held for you; if nobody claims a repo, its share returns to the funder's pool.
      </p>
    </PublicShell>
  );
}

export function ClaimComplete() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const repo = params.get("repo") ?? "";
  const [receiver, setReceiver] = useState("");
  const [done, setDone] = useState<any>(null);
  return (
    <PublicShell>
      <Card pad>
        <div className="row" style={{ gap: 12, marginBottom: 18, flexWrap: "nowrap" }}>
          <div className="icon-tile green" style={{ width: 42, height: 42 }}><BadgeCheck size={20} /></div>
          <div>
            <h1 style={{ fontSize: 22 }}>GitHub confirmed you maintain {repo.replace("github.com/", "")}</h1>
            <p className="muted">Last step: where should PayPal send your payouts?</p>
          </div>
        </div>
        {done ? (
          <div className="callout green"><CheckCircle2 size={18} color="var(--green)" /><div><strong>{done.repo}</strong> is verified and payable. You can close this page.</div></div>
        ) : (
          <>
            <div className="field" style={{ marginBottom: 14 }}>
              <label>PayPal account email</label>
              <input className="input" type="email" placeholder="you@example.com" value={receiver} onChange={(e) => setReceiver(e.target.value)} />
            </div>
            <ActionButton className="btn primary" disabled={!receiver || !token} onRun={async () => setDone(await api("/api/claims/complete", { body: { token, receiver } }))}>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="row" style={{ gap: 10 }}>
              <BrandIcon name="github" size={20} mono />
              <h1 style={{ fontSize: 20 }}>{data.repo.replace("github.com/", "")}</h1>
              <Status value={data.status} />
            </div>
            <p className="muted">
              This repository {data.status === "verified" ? "receives" : "is setting up"} Upstream payouts: when AI coding agents rely on it, their users' agent tithes are shared with its maintainers through PayPal.
            </p>
            <div className="muted small">Claim started {dateTime(data.created_at)}{data.verified_at ? ` · verified ${dateTime(data.verified_at)}` : ""}</div>
          </div>
        )}
      </Card>
    </PublicShell>
  );
}
