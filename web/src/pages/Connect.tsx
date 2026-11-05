import { useState } from "react";
import { Bot, Eye, KeyRound, Lock, PlugZap, Puzzle, RefreshCw, ShieldCheck, TerminalSquare } from "lucide-react";
import { api, useApi } from "../api.ts";
import { useOverview } from "../overview.tsx";
import { useBrand, useHealth } from "../brand.tsx";
import { ago, plural } from "../format.ts";
import { ActionButton, BrandIcon, Card, CheckRow, CodeBlock, PageHead, useToast } from "../ui.tsx";

const SKILLS = [
  { cmd: "/upstream-oss:receipt", what: "What this session relied on, and how its share would split" },
  { cmd: "/upstream-oss:credits", what: "An “Open-source credits” block for your PR description" },
];

export function Connect() {
  const { data } = useOverview();
  const connect = useApi<{ server_url: string; token: string | null; can_rotate: boolean }>("/api/me/connect");
  const toast = useToast();
  const [how, setHow] = useState<"hook" | "plugin">("hook");
  const [scope, setScope] = useState<"project" | "user">("project");
  const brand = useBrand();
  const source = useHealth().sourceUrl ?? "<SOURCE_REPO_URL>";
  // The hook posts to the server's PUBLIC_BASE_URL, which differs from this page's origin under the Vite dev server.
  const origin = connect.data?.server_url ?? data?.public_base_url ?? "<SERVER_URL>";
  const token = connect.data?.token ?? "<YOUR_TOKEN>";
  const f = data?.features ?? {};
  const operator = Boolean(data?.viewer?.operator);
  const sessions = data?.counts?.sessions ?? 0;
  const install = `git clone ${source} upstream-hook
node upstream-hook/hook/install.mjs --url ${origin} --token ${token} ${scope === "user" ? "--user" : "--project /path/to/your/project"}`;
  const plugin = `git clone ${source} upstream-hook
cd upstream-hook && npm install
claude --plugin-dir .

# Claude Code then asks for the plugin's settings:
#   ${brand} server URL  ${origin}
#   Ingest token         ${token}${operator ? "\n#   Admin token          optional, only for payout and top-up tools" : ""}`;

  return (
    <div className="page">
      <PageHead eyebrow="Setup" title="Connect your coding agent" subtitle="Run this once. It records what Claude Code actually does and sends it to your private space on this server, in the background." />
      <div className="split">
        <Card title="Your install command" sub="Already filled in with your own token" icon={<TerminalSquare size={17} />}>
          <div className="tabs" role="tablist" aria-label="Install method" style={{ marginBottom: 12 }}>
            <button role="tab" aria-selected={how === "hook"} className="tab" onClick={() => setHow("hook")}><TerminalSquare size={14} />Hook</button>
            <button role="tab" aria-selected={how === "plugin"} className="tab" onClick={() => setHow("plugin")}><Puzzle size={14} />Claude Code plugin</button>
          </div>
          {how === "hook" ? (
            <div className="stack">
              <div className="tabs" role="tablist" aria-label="Scope">
                <button role="tab" aria-selected={scope === "project"} className="tab" onClick={() => setScope("project")}>One project</button>
                <button role="tab" aria-selected={scope === "user"} className="tab" onClick={() => setScope("user")}>All projects</button>
              </div>
              <CodeBlock>{install}</CodeBlock>
              <p className="muted small">
                Needs Git and Node. It adds the hooks to <code>.claude/settings.json</code>, keeps your other hooks, and saves your token in <code>~/.upstream/config.json</code>. If this server can't be reached, events wait in <code>~/.upstream/spool.jsonl</code> and are sent later.
              </p>
            </div>
          ) : (
            <div className="stack">
              <CodeBlock>{plugin}</CodeBlock>
              <p className="muted small">The plugin adds the same hooks plus slash commands, and keeps your token in Claude Code's secure storage.</p>
              <div className="summary">
                {SKILLS.map((s) => (
                  <div key={s.cmd} className="line-row"><code>{s.cmd}</code><span className="muted small" style={{ textAlign: "right" }}>{s.what}</span></div>
                ))}
              </div>
            </div>
          )}
          <div className="callout" style={{ marginTop: 12 }}>
            <KeyRound size={16} />
            <div className="small" style={{ flex: 1 }}>
              Your token is like a password: anyone holding it can add sessions to your space, so don't share it.
              {!connect.data?.can_rotate && connect.data && " As this server's operator, your token is INGEST_TOKEN in the server's settings."}
            </div>
            {connect.data?.can_rotate && (
              <ActionButton
                className="btn sm"
                confirm={{ title: "Replace your token?", body: "Agents using the old token stop sending sessions until you run the new command.", confirmLabel: "Replace token" }}
                onRun={async () => {
                  connect.setData(await api("/api/me/connect/rotate", { body: {}, admin: true }));
                  toast("New token ready. Run the updated command.");
                }}
              >
                <RefreshCw size={14} />Replace
              </ActionButton>
            )}
          </div>
        </Card>
        <Card title="Status" sub="Updates live while you install" icon={<PlugZap size={17} />} tone="teal">
          <CheckRow ok={sessions > 0} label="First session received" detail={sessions ? `${plural(sessions, "session")}, ${data?.counts?.evidence ?? 0} evidence records` : "Waiting. Start a Claude Code session in that project and it appears here."} />
          <CheckRow ok={Boolean(f.llm)} label="AI review available" detail={f.llm ? `Model ${data?.model}` : "This server has no AI key yet, so only import counting runs."} />
          {data?.recent_paypal_calls?.[0] && <p className="muted small" style={{ marginTop: 8 }}>Your last PayPal call was {ago(data.recent_paypal_calls[0].at)}</p>}
        </Card>
      </div>

      <div className="grid-3">
        <Card title="What counts as use" icon={<Eye size={17} />} tone="violet">
          <p className="small" style={{ color: "var(--text-2)" }}>
            A dependency added, code written against a package's API, or a library's source read. Docs and searches count as support. A package that only sits in your lockfile is <strong>merely present</strong> and is never paid.
          </p>
        </Card>
        <Card title="Privacy" icon={<Lock size={17} />} tone="amber">
          <p className="small" style={{ color: "var(--text-2)" }}>
            Your sessions are visible only to you. Secret-looking files (<code>.env</code>, keys, credentials) are redacted before sending, and reads of your own files send just the path. Code your agent writes is sent, because that's how usage is measured, so only connect a server you trust.
          </p>
        </Card>
        <Card title="Tools for your agent" icon={<Bot size={17} />}>
          <p className="small" style={{ color: "var(--text-2)" }}>
            {operator
              ? <>The MCP server lets the agent show its evidence, write PR credits, plan a payout, send a batch <strong>you already approved</strong>, and ask for a top-up that <strong>you approve on PayPal</strong>. It never lets the model pick receivers or amounts.</>
              : <>Your agent can show its evidence and write PR credits with your token. Moving money stays with you: you plan and approve every payout on this site.</>}
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
