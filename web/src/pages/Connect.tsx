import { useState } from "react";
import { Bot, Copy, Eye, Lock, PlugZap, ShieldCheck, TerminalSquare } from "lucide-react";
import { useApi } from "../api.ts";
import { BrandIcon, Card, CheckRow, PageHead, useToast } from "../ui.tsx";

function Code({ children }: { children: string }) {
  const toast = useToast();
  return (
    <div style={{ position: "relative" }}>
      <pre className="codeblock">{children}</pre>
      <button
        className="btn sm"
        style={{ position: "absolute", top: 8, right: 8, background: "#262932", color: "#e7e9ee", borderColor: "#353945" }}
        onClick={() => navigator.clipboard.writeText(children).then(() => toast("Copied"))}
      >
        <Copy size={13} />Copy
      </button>
    </div>
  );
}

export function Connect() {
  const { data } = useApi<any>("/api/overview");
  const [scope, setScope] = useState<"project" | "user">("project");
  // The hook posts to the server's PUBLIC_BASE_URL, which differs from this page's origin under the Vite dev server.
  const origin = data?.public_base_url ?? "<PUBLIC_BASE_URL>";
  const f = data?.features ?? {};
  const install = `# from a clone of the Upstream repo
node hook/install.mjs --url ${origin} --token <INGEST_TOKEN> ${scope === "user" ? "--user" : "--project /path/to/your/project --with-mcp"}`;

  return (
    <div className="page">
      <PageHead title="Connect your coding agent" subtitle="Claude Code hooks record what the agent really did, on your machine, and send it to this server. Nothing depends on the agent choosing to call a special tool." />
      <div className="split">
        <Card title="1 · Install the hooks" sub="PostToolUse (async), SessionStart, Stop and SessionEnd" icon={<TerminalSquare size={17} />}>
          <div className="tabs" style={{ marginBottom: 12 }}>
            <button className={`tab ${scope === "project" ? "active" : ""}`} onClick={() => setScope("project")}>One project</button>
            <button className={`tab ${scope === "user" ? "active" : ""}`} onClick={() => setScope("user")}>All projects</button>
          </div>
          <Code>{install}</Code>
          <p className="muted small" style={{ marginTop: 10 }}>
            Use the server's <code>INGEST_TOKEN</code>. The installer merges into <code>.claude/settings.json</code>, keeps your other hooks, and stores the URL and token in <code>~/.upstream/config.json</code>. If the server is unreachable, events are spooled to <code>~/.upstream/spool.jsonl</code> and sent later.
          </p>
        </Card>
        <Card title="Status" icon={<PlugZap size={17} />} tone="teal">
          <CheckRow ok={Boolean(f.ingest)} label="Ingest endpoint enabled" detail="INGEST_TOKEN set on the server" />
          <CheckRow ok={(data?.counts?.sessions ?? 0) > 0} label="Events received" detail={`${data?.counts?.sessions ?? 0} session(s), ${data?.counts?.evidence ?? 0} evidence records`} />
          <CheckRow ok={Boolean(f.llm)} label="Claude attribution" detail={f.llm ? `Model ${data?.model}` : "ANTHROPIC_API_KEY not set"} />
          <CheckRow ok={Boolean(f.admin)} label="Admin actions" detail="ADMIN_TOKEN set on the server" />
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
        <Card title="2 · Optional: PayPal tools for the agent" icon={<Bot size={17} />}>
          <p className="small" style={{ color: "var(--text-2)" }}>
            <code>--with-mcp</code> registers the Upstream MCP server, so the agent can show its evidence, plan a payout and send a batch <strong>you already approved</strong>. PayPal's Agent Toolkit has no Payouts tool; this one never lets the model pick receivers or amounts.
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
