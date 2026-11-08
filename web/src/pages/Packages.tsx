import { useState } from "react";
import { Link } from "react-router-dom";
import { BadgeCheck, Boxes, ExternalLink, Hourglass, Link2, RefreshCw, Route, Send, ShieldAlert, ShieldCheck, ShieldQuestion, TerminalSquare } from "lucide-react";
import type { ColDef } from "ag-grid-community";
import { api, useApi } from "../api.ts";
import { ago, moneyStr, plural } from "../format.ts";
import { InviteModal } from "../invite.tsx";
import { useMoneyRefresh } from "../money/stream.tsx";
import { useOverview } from "../overview.tsx";
import { TrailDrawer } from "../trail.tsx";
import { useBrand } from "../brand.tsx";
import { ActionButton, BrandIcon, Card, EcoIcon, Empty, ErrorBox, Loading, PageHead, Stat, Status, useCopy, useToast } from "../ui.tsx";
import { Grid, moneyCol } from "../data.tsx";

function Provenance({ value }: { value: string | null }) {
  if (!value) return <span className="faint">—</span>;
  const attested = /SLSA_ATTESTATION|PUBLISH_ATTESTATION|GO_ORIGIN/.test(value);
  const Icon = attested ? ShieldCheck : value.startsWith("deps.dev") ? ShieldQuestion : ShieldAlert;
  const label = attested ? "Attested" : value.startsWith("deps.dev") ? "Unverified metadata" : value.startsWith("ecosyste.ms") ? "ecosyste.ms" : value.startsWith("npm-registry") ? "npm registry" : "Its own package.json";
  return (
    <span className={`pill ${attested ? "green" : "amber"}`} title={value}>
      <Icon size={12} />
      {label}
    </span>
  );
}

/** Funding links come from third-party metadata; one malformed URL must not break the whole grid. */
function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

export function Packages() {
  const { data, error, loading, reload, refresh } = useApi<any[]>("/api/packages");
  useMoneyRefresh((e) => e.type === "payout_status" || e.type === "earmark", refresh);
  const toast = useToast();
  const copy = useCopy();
  const { data: ov } = useOverview();
  const brand = useBrand();
  const [trail, setTrail] = useState<string | null>(null);
  const [inviting, setInviting] = useState<string | null>(null);
  const base = ov?.public_base_url ?? window.location.origin;
  const cols: ColDef<any>[] = [
    {
      headerName: "Package",
      field: "name",
      minWidth: 200,
      cellRenderer: (p: any) => (
        <span className="row" style={{ gap: 8, height: "100%" }}>
          <EcoIcon ecosystem={p.data.ecosystem} />
          <strong>{p.value}</strong>
        </span>
      ),
    },
    {
      headerName: "Source repository",
      field: "repo",
      minWidth: 240,
      cellRenderer: (p: any) =>
        p.value ? (
          <a className="row" style={{ gap: 6, height: "100%" }} href={`https://${p.value}`} target="_blank" rel="noreferrer">
            <BrandIcon name="github" size={13} mono />
            {p.value.replace("github.com/", "")}
            <ExternalLink size={12} />
          </a>
        ) : (
          <span className="faint">{p.data.resolve_error ?? "unresolved"}</span>
        ),
    },
    { headerName: "Repo link", field: "repo_provenance", minWidth: 200, maxWidth: 220, cellRenderer: (p: any) => <Provenance value={p.value} /> },
    {
      headerName: "Funding signals",
      field: "funding_links",
      minWidth: 170,
      valueGetter: (p) => p.data.funding_links?.length ?? 0,
      cellRenderer: (p: any) => {
        const links: string[] = p.data.funding_links ?? [];
        if (!links.length) return <span className="faint">none published</span>;
        return (
          <span className="row" style={{ gap: 6, height: "100%" }} title={links.join("\n")}>
            {links.slice(0, 3).map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="chip">{hostOf(u)}</a>
            ))}
            {links.length > 3 && <span className="muted small">+{links.length - 3}</span>}
          </span>
        );
      },
    },
    {
      headerName: "Maintainer",
      field: "claim",
      minWidth: 170,
      valueGetter: (p) => (p.data.claim ? "verified" : "unclaimed"),
      cellRenderer: (p: any) =>
        p.data.claim ? (
          <span className="row" style={{ gap: 6, height: "100%" }}>
            <Status value="verified" label={p.data.claim.github_login ? `@${p.data.claim.github_login}` : "Verified"} />
          </span>
        ) : (
          <Status value="pending" label="Unclaimed" />
        ),
    },
    moneyCol("Held", "reserved", (r: any) => r.currency, { maxWidth: 120 }),
    moneyCol("In flight", "in_flight", (r: any) => r.currency, { maxWidth: 120 }),
    moneyCol("Paid", "paid", (r: any) => r.currency, { maxWidth: 120 }),
    {
      headerName: "",
      colId: "actions",
      pinned: "right",
      minWidth: 210,
      maxWidth: 230,
      sortable: false,
      filter: false,
      cellRenderer: (p: any) =>
        p.data.repo ? (
          <span className="row" style={{ gap: 4, height: "100%" }}>
            <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setTrail(p.data.repo); }}><Route size={13} />Trail</button>
            {!p.data.claim && Number(p.data.reserved) > 0 && (
              <button className="btn ghost sm" title="Tell the maintainer money is waiting" onClick={(e) => { e.stopPropagation(); setInviting(p.data.repo); }}>
                <Send size={13} />{p.data.invited_at ? `Invited ${ago(p.data.invited_at)}` : "Invite"}
              </button>
            )}
            {!p.data.claim && Number(p.data.reserved) === 0 && (
              <button
                className="btn ghost sm"
                title="Copy a claim link to send the maintainer"
                onClick={(e) => { e.stopPropagation(); void copy(`${base}/claim?repo=${p.data.repo.replace("github.com/", "")}`, "Claim link copied. Send it to the maintainer."); }}
              >
                <Link2 size={13} />Claim link
              </button>
            )}
          </span>
        ) : null,
    },
  ];
  const rows = data ?? [];
  const cur: string | undefined = rows[0]?.currency ?? ov?.pool?.currency;
  // Held amounts are per repo, and several packages can share one repo: count each repo once.
  const heldByRepo = new Map(rows.filter((r) => r.repo).map((r) => [r.repo, Number(r.reserved)]));
  const heldTotal = [...heldByRepo.values()].reduce((a, v) => a + v, 0);
  const verified = new Set(rows.filter((r) => r.claim).map((r) => r.repo)).size;
  const repos = new Set(rows.filter((r) => r.repo).map((r) => r.repo)).size;
  const conflicts = (data ?? []).filter((d) => d.repo_conflict);

  return (
    <div className="page">
      <PageHead
        eyebrow="Step 3"
        title="Maintainers"
        subtitle="Every package your agent used, and who maintains it. Money only goes to maintainers who prove they run the repository."
        actions={
          <>
            <a className="btn" href="/claim" target="_blank" rel="noreferrer"><ShieldCheck size={16} />Open claim page</a>
            <ActionButton
              onRun={async () => {
                const r = await api<{ refreshed: number }>("/api/packages/refresh", { body: {}, admin: true });
                toast(`Refreshed ${plural(r.refreshed, "package")} from deps.dev, ecosyste.ms and GitHub.`);
                await reload();
              }}
            >
              <RefreshCw size={15} />
              Refresh metadata
            </ActionButton>
          </>
        }
      />
      {error && <ErrorBox error={error} />}
      {rows.length > 0 && (
        <div className="grid-4">
          <Stat label="Packages in your sessions" value={rows.length} icon={<Boxes size={15} />} foot={`${repos} source repositories`} />
          <Stat label="Verified maintainers" value={verified} tone="green" icon={<BadgeCheck size={15} />} foot="Proved admin/maintain access or a FUNDING.yml token" />
          <Stat label="Held for unclaimed repos" value={cur ? moneyStr(heldTotal.toFixed(6), cur) : "—"} tone="amber" icon={<Hourglass size={15} />} foot="Use Invite to send maintainers a claim link" />
          <Stat label="Repo not resolved" value={rows.filter((r) => !r.repo).length} tone="violet" icon={<ShieldQuestion size={15} />} foot="Can't be paid until a repo is found" />
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="callout amber">
          <ShieldAlert size={18} color="var(--amber)" />
          <div>
            <strong>Sources disagree on {plural(conflicts.length, "repo link")}.</strong> deps.dev notes its links are not verified for correctness, so {brand} prefers attested provenance and shows both. Check:{" "}
            {conflicts.map((c) => `${c.name} (${c.repo_conflict.depsdev} vs ${c.repo_conflict.ecosystems})`).join(", ")}
          </div>
        </div>
      )}
      <Card>
        {loading && !data ? <Loading /> : !data?.length ? (
          <Empty icon={<Boxes size={22} />} title="No packages yet" action={<Link className="btn" to="/sessions"><TerminalSquare size={15} />Review a session</Link>}>
            Packages appear once a session is attributed. {brand} then resolves each one to its source repository and funding links.
          </Empty>
        ) : (
          <Grid name="maintainers" rows={data} columns={cols} height={600} getRowId={(r) => `${r.ecosystem}:${r.name}`} onRowClick={(r) => r.repo && setTrail(r.repo)} />
        )}
      </Card>
      {trail && <TrailDrawer repo={trail} onClose={() => setTrail(null)} />}
      {inviting && <InviteModal repo={inviting} onClose={() => setInviting(null)} onSent={() => void refresh()} />}
    </div>
  );
}
