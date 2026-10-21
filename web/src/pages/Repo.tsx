import { Link, useParams } from "react-router-dom";
import { ArrowRight, BadgeCheck, HandCoins, Hourglass, Sparkles, TerminalSquare } from "lucide-react";
import { useApi } from "../api.ts";
import { ago, dateTime, moneyStr } from "../format.ts";
import { BrandIcon, Card, CodeBlock, EcoIcon, Loading, Status } from "../ui.tsx";
import { PublicShell } from "./Claim.tsx";
import { useHealth } from "../brand.tsx";

/** Public page for one repository: what agents relied on, what is waiting, and a README badge. */
export function RepoPage() {
  const { owner = "", name = "" } = useParams();
  const slug = `${owner}/${name}`;
  const { data, error, loading } = useApi<any>(`/api/public/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, [slug]);
  const h = useHealth();
  const base = h.publicBaseUrl ?? window.location.origin;
  const brand = h.name.toLowerCase();
  const badge = `[![${brand}](${base}/api/badge/${slug}.svg)](${base}/r/${slug})`;
  const verified = data?.claim?.status === "verified";

  return (
    <PublicShell wide>
      <Card pad>
        <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div className="icon-tile" style={{ width: 44, height: 44 }}><BrandIcon name="github" size={22} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="eyebrow">Open-source repository</div>
            <h1 style={{ fontSize: 24 }}><a href={`https://github.com/${slug}`} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{slug}</a></h1>
            <div className="row" style={{ marginTop: 6, gap: 8 }}>
              {data ? <Status value={data.claim.status} label={verified ? (data.claim.github_login ? `Verified · @${data.claim.github_login}` : "Verified maintainer") : data.claim.status === "pending" ? "Claim in progress" : "Not claimed yet"} /> : null}
              {data?.last_relied_at && <span className="muted small">Last relied on {ago(data.last_relied_at)}</span>}
            </div>
          </div>
          {!verified && <Link className="btn primary lg" to={`/claim?repo=${slug}`}>Claim this repo<ArrowRight size={16} /></Link>}
        </div>
      </Card>

      {loading && !data && !error ? <Loading rows={1} /> : error ? (
        <Card pad>
          <div className="empty" style={{ padding: 16 }}>
            <div className="icon-tile"><Sparkles size={22} /></div>
            <h3>No agent has relied on this repository here yet</h3>
            <div className="body">When AI coding sessions tracked by this server install, import or study one of its packages, its share shows up on this page. You can claim it now so payouts reach you as soon as there are any.</div>
          </div>
        </Card>
      ) : data && (
        <>
          <div className="grid-3">
            <Big icon={<Hourglass size={15} />} tone="amber" label="Waiting for a maintainer" value={moneyStr(data.held, data.currency)} foot={verified ? "Goes out in the next payout run" : "Held until someone verifies"} />
            <Big icon={<HandCoins size={15} />} tone="green" label="Paid through PayPal" value={moneyStr(data.paid, data.currency)} foot={Number(data.in_flight) > 0 ? `${moneyStr(data.in_flight, data.currency)} in flight` : "Confirmed by PayPal"} />
            <Big icon={<TerminalSquare size={15} />} label="Agent sessions that relied on it" value={String(data.sessions_relied)} foot="Install, import, API use or source read" />
          </div>
          {data.packages.length > 0 && (
            <Card title="Packages from this repository" icon={<Sparkles size={17} />} tone="violet">
              <div className="row" style={{ gap: 8 }}>
                {data.packages.map((p: any) => <span key={`${p.ecosystem}:${p.name}`} className="chip"><EcoIcon ecosystem={p.ecosystem} size={13} />{p.name}</span>)}
              </div>
            </Card>
          )}
          {verified && data.claim.verified_at && <Proof slug={slug} claim={data.claim} />}
          {data.payouts.length > 0 && (
            <Card title="Payouts PayPal reported" sub="Each line is a PayPal payout item. The maintainer can find it in their PayPal activity by its transaction id." icon={<HandCoins size={17} />} tone="green">
              <div className="summary">
                {data.payouts.map((p: any, i: number) => (
                  <div key={`${p.at}-${i}`} className="line-row" style={{ alignItems: "center" }}>
                    <span className="row" style={{ gap: 8, minWidth: 0 }}>
                      <Status value={p.status} />
                      <span className="muted small">{dateTime(p.at)}</span>
                      {p.transaction_id ? <code className="small" title="PayPal transaction id">{p.transaction_id}</code> : <span className="muted small">no transaction id from PayPal yet</span>}
                    </span>
                    <strong className="num">{moneyStr(p.amount, data.currency)}</strong>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      <Card title="Add the badge to your README" sub="Shows what agents have paid or what's waiting, and links back here" icon={<BadgeCheck size={17} />} tone="teal">
        <div className="stack">
          <div className="card flat" style={{ padding: 16, display: "grid", placeItems: "center" }}>
            <img src={`/api/badge/${slug}.svg`} alt={`${brand} badge for ${slug}`} height={20} />
          </div>
          <CodeBlock>{badge}</CodeBlock>
        </div>
      </Card>
    </PublicShell>
  );
}

/** How the maintainer proved control, in terms anyone can re-check on GitHub. The payout email is never shown. */
function Proof({ slug, claim }: { slug: string; claim: any }) {
  const p = claim.proof;
  return (
    <div className="callout green">
      <BadgeCheck size={18} color="var(--green)" />
      <div className="small">
        {p?.method === "funding_yml_token" ? (
          <>
            On {dateTime(claim.verified_at)}, this server found its claim link in{" "}
            {p.path ? <a href={`https://github.com/${slug}/blob/HEAD/${p.path}`} target="_blank" rel="noreferrer"><code>{p.path}</code></a> : "the repository's FUNDING.yml"} on the default branch, which only someone with push access can commit.
            {p.link && <> Anyone can check it: the file should list <code style={{ overflowWrap: "anywhere" }}>{p.link}</code>.</>}
          </>
        ) : (
          <>
            On {dateTime(claim.verified_at)}, {claim.github_login ? <strong>@{claim.github_login}</strong> : "a maintainer"} signed in with GitHub, and GitHub reported{" "}
            {p?.permission ? <strong>{p.permission}</strong> : "admin or maintain"} permission on this repository.
          </>
        )}{" "}
        Payouts go to the PayPal account they chose; the address is never published.
      </div>
    </div>
  );
}

function Big({ icon, label, value, foot, tone }: { icon: React.ReactNode; label: string; value: string; foot: string; tone?: string }) {
  return (
    <div className="card stat">
      <div className="stat-label"><div className={`icon-tile ${tone ?? ""}`} style={{ width: 28, height: 28, borderRadius: 8 }}>{icon}</div>{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">{foot}</div>
    </div>
  );
}
