// "How it's built": every outside tool and service Upstream relies on, what it does here, and where to see it.
// Public, so anyone can read it. The live lines come from /api/public/stack, which holds counts and versions, nothing personal.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, ChartNoAxesCombined, Code2, Server, Table2, Terminal } from "lucide-react";
import { useApi } from "../api.ts";
import { ago, plural } from "../format.ts";
import { BrandIcon, Card, PayPalMark } from "../ui.tsx";
import { PublicShell } from "./Claim.tsx";

interface Stack {
  paypal_env: string;
  sdk: { package: string; version: string; calls: number; last_at: string | null };
  direct: { calls: number; last_at: string | null };
  model: string;
  hosting: { provider: string; commit: string | null; service: string | null } | null;
}

function Where({ items }: { items: { to: string; label: string }[] }) {
  return (
    <div className="built-where">
      <span className="muted small">Where you see it</span>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {items.map((i) => <Link key={i.to + i.label} className="pill outline" to={i.to}>{i.label}</Link>)}
      </div>
    </div>
  );
}

function Live({ children }: { children: ReactNode }) {
  return <div className="built-live"><span className="dot" />{children}</div>;
}

export function BuiltWith() {
  const { data } = useApi<Stack>("/api/public/stack");
  const total = data ? data.sdk.calls + data.direct.calls : 0;
  return (
    <PublicShell wide to="/" tagline="How it's built">
      <section className="stack" style={{ gap: 6, textAlign: "center" }}>
        <h1 style={{ fontSize: 30 }}>How Upstream is built</h1>
        <p className="muted">Every outside tool and service this app relies on, what it does here, and where you can see it working. The numbers marked live come from this server.</p>
      </section>

      <Card title="PayPal" sub="Every dollar moves through PayPal" icon={<PayPalMark size={17} />}>
        <div className="stack">
          <p>
            You fund a budget with <b>Subscriptions</b> or a one-time payment with <b>Orders v2</b>. <b>Payouts</b> pays maintainers who have proven they run
            the repository, signed <b>webhooks</b> and an hourly check keep the records straight, <b>Log in with PayPal</b> can verify a maintainer's payout email,
            and monthly statements are issued as PayPal invoices through PayPal's <b>Agent Toolkit</b>.
          </p>
          {data && <Live>{plural(total, "call")} to PayPal's {data.paypal_env} on this server so far.</Live>}
          <Where items={[{ to: "/funding", label: "Add funds" }, { to: "/settlements", label: "Pay maintainers" }, { to: "/ledger", label: "Money records" }, { to: "/claim", label: "Claim page" }]} />
        </div>
      </Card>

      <Card title="APIMatic: PayPal's Server SDK" sub="PayPal's official TypeScript SDK, which APIMatic generates from PayPal's API definitions" icon={<Code2 size={17} />} tone="teal">
        <div className="stack">
          <p>
            One-time top-ups and the monthly budget go through <code>{data?.sdk.package ?? "@paypal/paypal-server-sdk"}</code>. The SDK builds each request from
            its typed models, sets PayPal's idempotency key and <code>Prefer</code> header, and turns PayPal's error replies into typed errors.
          </p>
          <div className="built-cols">
            <div>
              <div className="muted small">Through the SDK</div>
              <ul className="built-list">
                <li>Orders v2: create, capture and read a top-up</li>
                <li>Subscriptions: create the plan, start a subscription, read it, list its payments</li>
              </ul>
            </div>
            <div>
              <div className="muted small">Direct REST calls, because the SDK doesn't cover them</div>
              <ul className="built-list">
                <li>Payouts, Webhooks, Log in with PayPal, Catalog Products</li>
              </ul>
            </div>
          </div>
          <p className="muted small">
            Every SDK request travels over Upstream's own connection to PayPal, so it uses the same token and appears in the PayPal API log marked
            <b> APIMatic SDK</b>.
          </p>
          {data && (
            <Live>
              Version {data.sdk.version}. {plural(data.sdk.calls, "call")} made through it on this server{data.sdk.last_at ? `, the last ${ago(data.sdk.last_at)}` : ""}.
            </Live>
          )}
          <Where items={[{ to: "/funding", label: "Add funds" }, { to: "/ledger", label: "Money records: PayPal API log" }]} />
        </div>
      </Card>

      <Card title="Bryntum Scheduler" sub="Community edition, MIT licensed" icon={<CalendarClock size={17} />} tone="violet">
        <div className="stack">
          <p>
            Draws the <b>money timeline</b>: a row for your budget and one for each repository your agent relied on, with a bar for every payment in, payout and
            held share, and what's scheduled next: your next PayPal payment, the day a held share goes back to your pool, the day an unclaimed payout is cancelled.
          </p>
          <p className="muted small">Read-only, coloured to match the money diagram, follows the app's light or dark theme, and loaded only on that page.</p>
          <Where items={[{ to: "/ledger", label: "Money records: Money timeline" }]} />
        </div>
      </Card>

      <Card title="AG Studio: the Insights board" sub="Embedded analytics by AG Grid, with two widgets of our own" icon={<ChartNoAxesCombined size={17} />} tone="teal">
        <div className="stack">
          <p>
            <b>Insights</b> puts the money and the attribution on one board. Its data comes from this server's own records through{" "}
            <code>/api/studio/data</code>: sessions, each package's share by method, allocations, payouts, maintainers, the ledger and the money events, for
            the person viewing only, and without any receiver, token or PayPal id.
          </p>
          <p>
            Two widgets are ours. <b>Declared vs used</b> puts what an equal split of the dependency list would pay each package beside what Upstream pays it
            from evidence, and tags packages the list pays but the agent never used. <b>Money trail</b> shows each maintainer's money as held, sent and paid,
            with PayPal's own status. Click either and the whole board filters. Both describe themselves to Studio's agents.
          </p>
          <p className="muted small">
            Themed from the app's own colours, fonts and chart palette, light and dark. Visitors can rearrange the board; the layout stays in their browser.
            Code: <code>server/src/studio/</code>, <code>web/src/insights/</code>.
          </p>
          <Where items={[{ to: "/insights", label: "Insights" }]} />
        </div>
      </Card>

      <Card title="AG Grid and AG Charts" sub="In every table and chart of the app" icon={<Table2 size={17} />}>
        <div className="stack">
          <p>
            Every table of records is an AG Grid, sortable, filterable and resizable, and every comparison is an AG Chart. Both share one themed wrapper, follow
            the app's theme, and load only on the pages that use them. The app's own pages use the Community editions; the Insights board runs the Enterprise
            editions that come with AG Studio.
          </p>
          <Where
            items={[
              { to: "/sessions", label: "Coding sessions" },
              { to: "/packages", label: "Maintainers" },
              { to: "/settlements", label: "Pay maintainers: items and allocations" },
              { to: "/ledger", label: "Money records: ledger, API log, breakdown" },
              { to: "/sessions", label: "A session: Muse Spark vs counting imports" },
              { to: "/eval", label: "AI accuracy" },
            ]}
          />
        </div>
      </Card>

      <Card title="Meta Muse Spark" sub="The AI that weighs the evidence" icon={<BrandIcon name="meta" size={17} />}>
        <div className="stack">
          <p>
            Reads what the agent did in a session, proposes how much each package mattered, and must cite the evidence for every share. Code then drops anything it
            can't back up, and a person approves every payout.
          </p>
          {data && <Live>Model {data.model}.</Live>}
          <Where items={[{ to: "/sessions", label: "A session: Review with Muse Spark" }, { to: "/check", label: "Check a session" }]} />
        </div>
      </Card>

      <Card title="Claude Code" sub="The coding agent being measured" icon={<Terminal size={17} />}>
        <div className="stack">
          <p>
            Hooks record every install, import, API call, source read and docs lookup the agent makes, without the agent having to cooperate. A Claude Code plugin
            bundles the hooks, an MCP server with guarded payout tools, and four skills.
          </p>
          <Where items={[{ to: "/connect", label: "Connect your agent" }, { to: "/sessions", label: "Coding sessions" }]} />
        </div>
      </Card>

      <Card title="Render" sub="Hosting" icon={<Server size={17} />}>
        <div className="stack">
          <p>One web service runs the API, the live money stream and this dashboard, with a persistent disk for the SQLite database.</p>
          {data && (
            <Live>
              {data.hosting ? `This server is running on ${data.hosting.provider}${data.hosting.commit ? `, commit ${data.hosting.commit}` : ""}.` : "This server isn't running on Render: it's a local or self-hosted copy."}
            </Live>
          )}
        </div>
      </Card>

      <p className="muted small" style={{ textAlign: "center" }}>
        <Link to="/">Home</Link> · <Link to="/check">Check a session</Link> · <Link to="/claim">For maintainers</Link>
      </p>
    </PublicShell>
  );
}
