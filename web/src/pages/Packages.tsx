import { Boxes, ExternalLink, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { ColDef } from "ag-grid-community";
import { api, useApi } from "../api.ts";
import { moneyStr } from "../format.ts";
import { ActionButton, BrandIcon, Card, EcoIcon, Empty, ErrorBox, Loading, PageHead, Status, useToast } from "../ui.tsx";
import { Grid } from "../data.tsx";

function Provenance({ value }: { value: string | null }) {
  if (!value) return <span className="faint">—</span>;
  const attested = /SLSA_ATTESTATION|PUBLISH_ATTESTATION|GO_ORIGIN/.test(value);
  const Icon = attested ? ShieldCheck : value.startsWith("deps.dev") ? ShieldQuestion : ShieldAlert;
  const label = attested ? "Attested" : value.startsWith("deps.dev") ? "Unverified metadata" : "ecosyste.ms";
  return (
    <span className={`pill ${attested ? "green" : "amber"}`} title={value}>
      <Icon size={12} />
      {label}
    </span>
  );
}

export function Packages() {
  const { data, error, loading, reload } = useApi<any[]>("/api/packages");
  const toast = useToast();
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
              <a key={u} href={u} target="_blank" rel="noreferrer" className="chip">{new URL(u).hostname.replace("www.", "")}</a>
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
    { headerName: "Held", field: "reserved", maxWidth: 120, type: "numericColumn", cellClass: "num", valueFormatter: (p) => moneyStr(p.value, p.data.currency) },
    { headerName: "In flight", field: "in_flight", maxWidth: 120, type: "numericColumn", cellClass: "num", valueFormatter: (p) => moneyStr(p.value, p.data.currency) },
    { headerName: "Paid", field: "paid", maxWidth: 120, type: "numericColumn", cellClass: "num", valueFormatter: (p) => moneyStr(p.value, p.data.currency) },
  ];
  const conflicts = (data ?? []).filter((d) => d.repo_conflict);

  return (
    <div className="page">
      <PageHead
        title="Packages & maintainers"
        subtitle="Package → repo comes from deps.dev and ecosyste.ms; funding signals from registry metadata and FUNDING.yml. Money only goes to maintainers who prove they control the repo."
        actions={
          <>
            <a className="btn" href="/claim" target="_blank" rel="noreferrer"><ShieldCheck size={16} />Open claim page</a>
            <ActionButton
              onRun={async () => {
                const r = await api<{ refreshed: number }>("/api/packages/refresh", { body: {}, admin: true });
                toast(`Refreshed ${r.refreshed} package(s) from deps.dev, ecosyste.ms and GitHub.`);
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
      {conflicts.length > 0 && (
        <div className="callout amber">
          <ShieldAlert size={18} color="var(--amber)" />
          <div>
            <strong>Sources disagree on {conflicts.length} repo link(s).</strong> deps.dev notes its links are not verified for correctness, so Upstream prefers attested provenance and shows both. Check:{" "}
            {conflicts.map((c) => `${c.name} (${c.repo_conflict.depsdev} vs ${c.repo_conflict.ecosystems})`).join(", ")}
          </div>
        </div>
      )}
      <Card>
        {loading && !data ? <Loading /> : !data?.length ? (
          <Empty icon={<Boxes size={22} />} title="No packages yet">Packages appear after a session is attributed.</Empty>
        ) : (
          <Grid rows={data} columns={cols} height={600} getRowId={(r) => `${r.ecosystem}:${r.name}`} />
        )}
      </Card>
    </div>
  );
}
