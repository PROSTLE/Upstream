import { useState } from "react";
import { Bot, Eye, Lock, PlugZap, Puzzle, ShieldCheck, TerminalSquare } from "lucide-react";
import { useOverview } from "../overview.tsx";
import { useBrand } from "../brand.tsx";
import { ago, plural } from "../format.ts";
import { BrandIcon, Card, CheckRow, CodeBlock, PageHead } from "../ui.tsx";

const SKILLS = [
  { cmd: "/upstream-oss:receipt", what: "What this session relied on, and how its share would split" },
  { cmd: "/upstream-oss:credits", what: "An “Open-source credits” block for your PR description" },
  { cmd: "/upstream-oss:fund 10", what: "Ask for a one-time PayPal top-up; you approve it on PayPal" },
];

export function Connect() {
  const { data } = useOverview();
  const [how, setHow] = useState<"plugin" | "hook">("plugin");
  const [scope, setScope] = useState<"project" | "user">("project");
  // The hook posts to the server's PUBLIC_BASE_URL, which differs from this page's origin under the Vite dev server.
  const origin = data?.public_base_url ?? "<PUBLIC_BASE_URL>";
  const f = data?.features ?? {};
  const sessions = data?.counts?.sessions ?? 0;
  const brand = useBrand();
  const plugin = `# in a clone of the ${brand} repo, after npm install
claude --plugin-dir /path/to/upstream

# Claude Code then asks for the plugin's settings:
#   ${brand} server URL  ${origin}
#   Ingest token         the server's INGEST_TOKEN
#   Admin token          optional, only for payout and top-up tools`;
  const install = `# from a clone of the ${brand} repo
node hook/install.mjs --url ${origin} --token <INGEST_TOKEN> ${scope === "user" ? "--user" : "--project /path/to/your/project --with-mcp"}`;

  return (
    <div className="page">
      <PageHead eyebrow="Setup" title="Connect your coding agent" subtitle="Claude Code hooks record what the agent really did, on your machine, and send it to this server. Nothing depends on the agent choosing to call a special tool." />
      <div className="split">
        <Card title="Install" sub="Hooks: SessionStart, PostToolUse (async), Stop and SessionEnd" icon={<TerminalSquare size={17} />}>
          <div className="tabs" role="tablist" aria-label="Install method" style={{ marginBottom: 12 }}>
            <button role="tab" aria-selected={how === "plugin"} className="tab" onClick={() => setHow("plugin")}><Puzzle size={14} />Claude Code plugin</button>
            <button role="tab" aria-selected={how === "hook"} className="tab" onClick={() => setHow("hook")}><TerminalSquare size={14} />Hook installer</button>
          </div>
          {how === "plugin" ? (
            <div className="stack">
              <CodeBlock>{plugin}</CodeBlock>
              <p className="muted small">
                One step: the plugin bundles the hooks, the MCP server and three slash commands. Tokens you enter are kept in Claude Code's secure storage. Spooling works the same: if the server is unreachable, events wait in <code>~/.upstream/spool.jsonl</code>.
              </p>
              <div className="summary">
                {SKILLS.map((s) => (
                  <div key={s.cmd} className="line-row"><code>{s.cmd}</code><span className="muted small" style={{ textAlign: "right" }}>{s.what}</span></div>
                ))}
              </div>
            </div>
          ) : (
            <div className="stack">
              <div className="tabs" role="tablist" aria-label="Scope">
                <button role="tab" aria-selected={scope === "project"} className="tab" onClick={() => setScope("project")}>One project</button>
                <button role="tab" aria-selected={scope === "user"} className="tab" onClick={() => setScope("user")}>All projects</button>
              </div>
              <CodeBlock>{install}</CodeBlock>
              <p className="muted small">
                Use the server's <code>INGEST_TOKEN</code>. The installer merges into <code>.claude/settings.json</code>, keeps your other hooks, and stores the URL and token in <code>~/.upstream/config.json</code>. If the server is unreachable, events are spooled to <code>~/.upstream/spool.jsonl</code> and sent later.
              </p>
            </div>
          )}
        </Card>
        <Card title="Status" sub="Updates live while you install" icon={<PlugZap size={17} />} tone="teal">
          <CheckRow ok={Boolean(f.ingest)} label="Ingest endpoint enabled" detail="INGEST_TOKEN set on the server" />
          <CheckRow ok={sessions > 0} label="Events received" detail={sessions ? `${plural(sessions, "session")}, ${data?.counts?.evidence ?? 0} evidence records` : "Waiting for the first hook event. Start a Claude Code session in the project."} />
          <CheckRow ok={Boolean(f.llm)} label="Muse Spark attribution" detail={f.llm ? `Model ${data?.model}` : "MODEL_API_KEY not set"} />
          <CheckRow ok={Boolean(f.admin)} label="Admin actions" detail="ADMIN_TOKEN set on the server" />
          <CheckRow ok={Boolean(f.agentTopups)} label="Agent top-up requests" detail={f.agentTopups ? `Up to ${data?.policy?.max_agent_topup} ${data?.pool?.currency} per 24 hours, each approved by you in PayPal` : "Off: set POLICY_MAX_AGENT_TOPUP to allow /upstream-oss:fund"} />
          {data?.recent_paypal_calls?.[0] && <p className="muted small" style={{ marginTop: 8 }}>Last PayPal call {ago(data.recent_paypal_calls[0].at)}</p>}
        </Card>
      </div>

      <div className="grid-3">
        <Card title="What counts as use" icon={<Eye size={17} />} tone="violet">
          <p className="small" style={{ color: "var(--text-2)" }}>
            Following ATTRIBUTION.md's idea of meaningful reuse: a dependency added, code written against a package's API, or a library's source read and its logic reimplemented. Docs and searches count as support. A package that only sits in your lockfile is <strong>merely present</strong> and is never paid.
          </p>
        </Card>
        <Card title="Privacy" icon={<Lock size={17} />} tone="amber">
          <p className="small" style={{ color: "var(--text-2)" }}>
            Events go only to the server you configure. Secret-looking files (<code>.env</code>, keys, credentials) are redacted before sending, and reads of your own files send just the path. Library sources under <code>node_modules</code> or <code>site-packages</code> are sent as short excerpts.
          </p>
        </Card>
        <Card title="PayPal tools for the agent" icon={<Bot size={17} />}>
          <p className="small" style={{ color: "var(--text-2)" }}>
            The MCP server lets the agent show its evidence, write PR credits, plan a payout, send a batch <strong>you already approved</strong>, and ask for a top-up that <strong>you approve on PayPal</strong>. PayPal's Agent Toolkit has no Payouts tool; this one never lets the model pick receivers or amounts.
          </p>
          <div className="row" style={{ marginTop: 10, gap: 6 }}>
            <span className="chip"><BrandIcon name="claude" size={13} />Claude Code</span>
            <span className="chip"><ShieldCheck size={13} color="var(--green)" />Human-approved only</span>
          </div>
        </Card>
      </div>
    </div>
  );
}
