import { Link, useSearchParams } from "react-router-dom";
import { Activity, ArrowRight, BadgeCheck, Bot, CircleCheck, FileSearch, HandCoins, ReceiptText, ShieldCheck, Wallet } from "lucide-react";
import { useApi } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { useBrand, useHealth } from "../brand.tsx";
import { moneyStr, plural } from "../format.ts";
import { Galaxy } from "../galaxy.tsx";
import { BrandIcon, ErrorBox, EVIDENCE, Logo } from "../ui.tsx";

type PublicActivity = {
  currency: string;
  sessions_reviewed: number;
  packages_credited: number;
  packages_left_out: number;
  verified_maintainers: number;
  paid: string;
  held: string;
  recent: { ecosystem: string; name: string; classification: string; repo: string | null; signals: string[] }[];
};

const STEPS = [
  { icon: Wallet, title: "Set your budget", text: "Sign in and approve a monthly amount on PayPal's own page, or add money once. It's yours alone." },
  { icon: FileSearch, title: "Code as usual", text: "Your own background hook records what your agent installs, imports and reads, privately." },
  { icon: Bot, title: "AI weighs the evidence", text: "Muse Spark proposes who gets what and must cite proof. Code drops anything it can't back up." },
  { icon: HandCoins, title: "Maintainers get paid", text: "Maintainers prove they run the repo. You approve, then PayPal sends the money." },
];

const WHY = [
  { icon: FileSearch, title: "Real use, not a package list", text: "A package only gets paid when there is evidence your agent really used it. Being listed in package.json is not enough." },
  { icon: ShieldCheck, title: "The AI never moves money", text: "It only makes a proposal. Budgets, caps and verified receivers are enforced in code, and you approve each payout." },
  { icon: ReceiptText, title: "Every payment is traceable", text: "Follow any payout back to the session and evidence behind it, using PayPal's own records." },
];

function SignIn({ large }: { large?: boolean }) {
  const { user, available } = useAuth();
  const access = useHealth().access;
  const size = large ? " lg" : "";
  if (user) return <Link className={`btn primary${size}`} to="/dashboard">Open your dashboard<ArrowRight size={16} /></Link>;
  if (available) return <a className={`btn primary${size}`} href="/api/auth/github/start"><BrandIcon name="github" size={16} mono />Sign in with GitHub</a>;
  if (access === "public") return <Link className={`btn primary${size}`} to="/dashboard">See the live demo<ArrowRight size={16} /></Link>;
  return <Link className={`btn primary${size}`} to="/unlock">Open the dashboard<ArrowRight size={16} /></Link>;
}

/** Real totals from this server, refreshed while the page is open. Nothing here is written by hand. */
function LiveActivity() {
  const { data, error } = useApi<PublicActivity>("/api/public/activity", [], { poll: 30000 });
  if (error) return null;
  const reviewed = data?.sessions_reviewed ?? 0;
  const stats = data
    ? [
        { label: "Sessions reviewed", value: String(reviewed) },
        { label: "Packages credited", value: String(data.packages_credited) },
        { label: "Left out, unused", value: String(data.packages_left_out) },
        { label: "Paid to maintainers", value: moneyStr(data.paid, data.currency) },
      ]
    : [];
  return (
    <figure className="home-receipt" aria-label="Live activity on this server" aria-busy={!data}>
      <figcaption>
        <strong><Activity size={15} aria-hidden />Live from this server</strong>
        <span>{data && reviewed ? `Across ${plural(reviewed, "reviewed session")}. Projects stay private.` : "Real activity appears here as it happens."}</span>
      </figcaption>
      {data && (
        <div className="home-stats">
          {stats.map((s) => <div key={s.label}><b>{s.value}</b><span>{s.label}</span></div>)}
        </div>
      )}
      {data && data.recent.length > 0 && (
        <ul>
          {data.recent.map((r) => {
            const body = (
              <>
                <CircleCheck size={19} color="var(--green)" aria-hidden />
                <div>
                  <code>{r.name}</code>
                  <p>{r.signals.map((k) => EVIDENCE[k]?.label ?? k).join(" · ") || "Credited by the AI review"}</p>
                </div>
              </>
            );
            return <li key={`${r.ecosystem}:${r.name}`}>{r.repo ? <Link to={`/r/${r.repo.replace("github.com/", "")}`}>{body}</Link> : body}</li>;
          })}
        </ul>
      )}
      {data && reviewed === 0 && <p className="home-empty">No session has been reviewed on this server yet. The first one will show up here.</p>}
    </figure>
  );
}

export function Home() {
  const brand = useBrand();
  const { user, available } = useAuth();
  const health = useHealth();
  const [params] = useSearchParams();
  const authError = params.get("auth_error");
  return (
    <div className="home">
      <Galaxy />
      <div className="home-content">
        <header className="home-nav">
          <Link to="/" className="home-brand"><Logo size={30} /><span>{brand}</span></Link>
          <nav className="home-links" aria-label="Page">
            <a href="#how">How it works</a>
            <Link to="/claim">For maintainers</Link>
            <Link to="/how-its-built">How it's built</Link>
            {health.sourceUrl && <a href={health.sourceUrl} target="_blank" rel="noreferrer">Source</a>}
          </nav>
          <SignIn />
        </header>

        <main>
          <section className="home-hero">
            <div>
              <h1>Your AI agent uses open source all day. Pay the people who built it.</h1>
              <p className="home-lead">{brand} records which packages your coding agent really relied on, has AI weigh the evidence, and pays their maintainers through PayPal.</p>
              {authError && <div style={{ marginBottom: 16 }}><ErrorBox error={authError} /></div>}
              <div className="home-cta">
                <SignIn large />
                {!user && available && health.access === "public" && <Link className="btn lg" to="/dashboard">See the live demo<ArrowRight size={16} /></Link>}
                {health.publicCheck && <Link className="btn lg" to="/check"><FileSearch size={16} />Check your own session (no install)</Link>}
                <Link className="btn lg" to="/claim">I maintain open source</Link>
              </div>
              {!user && health.access === "public" && (
                <p className="home-note">The live demo is the creator's own space, open to everyone with no sign-in: real sessions, AI reviews and payouts, read-only.</p>
              )}
              {health.paypalEnv === "sandbox" && <p className="home-note">Test mode: this server uses the PayPal sandbox, so no real money moves.</p>}
            </div>
            <LiveActivity />
          </section>

          <section id="how" className="home-section">
            <h2>How it works</h2>
            <ol className="home-steps">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="home-step-n">{i + 1}</span>
                  <s.icon size={20} aria-hidden />
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
          </section>

          <section className="home-section">
            <h2>Why you can trust the split</h2>
            <div className="home-why">
              {WHY.map((w) => (
                <div key={w.title}>
                  <w.icon size={20} aria-hidden />
                  <h3>{w.title}</h3>
                  <p>{w.text}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="home-section home-paths">
            <div>
              <h2>I code with AI agents</h2>
              <p>Give back to the projects your agent depends on, with your own private budget and payouts.</p>
              <SignIn />
            </div>
            <div>
              <h2>I maintain open source</h2>
              <p>Prove you run your repository and choose where PayPal should send your payouts.</p>
              <Link className="btn" to="/claim"><BadgeCheck size={15} />Claim your project</Link>
            </div>
          </section>
        </main>

        <footer className="home-foot">
          <span>{brand}. Open source under the MIT license.</span>
          <span className="row" style={{ gap: 16 }}>
            <Link to="/how-its-built">How it's built</Link>
            {health.sourceUrl && <a href={health.sourceUrl} target="_blank" rel="noreferrer">GitHub</a>}
            {!user && <Link to="/unlock">{available ? "Sign in with a token" : "Admin token"}</Link>}
          </span>
        </footer>
      </div>
    </div>
  );
}
