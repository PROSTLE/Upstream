import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, BadgeCheck, Bot, CircleCheck, CircleX, FileSearch, HandCoins, ReceiptText, ShieldCheck, Wallet } from "lucide-react";
import { useAuth } from "../auth.tsx";
import { useBrand, useHealth } from "../brand.tsx";
import { BrandIcon, ErrorBox, Logo } from "../ui.tsx";

const SOURCE_URL = "https://github.com/PROSTLE/Upstream";

// Every row is what the benchmark's live model runs actually did (scenarios S1 and S6, 3 of 3 runs each). No money figures are implied.
const RECEIPT = [
  { name: "zod", why: "Installed, then used in the code the agent wrote", paid: true },
  { name: "react", why: "Only listed in package.json, never touched", paid: false },
  { name: "left-pad", why: "Its README told the AI to pay it. The AI flagged that and paid nothing", paid: false },
];

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

export function Home() {
  const brand = useBrand();
  const { user, available } = useAuth();
  const health = useHealth();
  const [params] = useSearchParams();
  const authError = params.get("auth_error");
  return (
    <div className="home">
      <header className="home-nav">
        <Link to="/" className="home-brand"><Logo size={30} /><span>{brand}</span></Link>
        <nav className="home-links" aria-label="Page">
          <a href="#how">How it works</a>
          <Link to="/claim">For maintainers</Link>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">Source</a>
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
              <Link className="btn lg" to="/claim">I maintain open source</Link>
            </div>
            {health.paypalEnv === "sandbox" && <p className="home-note">Test mode: this server uses the PayPal sandbox, so no real money moves.</p>}
          </div>

          <figure className="home-receipt" aria-label="Example results from a test run">
            <figcaption>
              <strong>What the agent actually used</strong>
              <span>Live AI results from our scripted test sessions</span>
            </figcaption>
            <ul>
              {RECEIPT.map((r) => (
                <li key={r.name}>
                  {r.paid ? <CircleCheck size={19} color="var(--green)" aria-hidden /> : <CircleX size={19} color="var(--faint)" aria-hidden />}
                  <div>
                    <code>{r.name}</code>
                    <p>{r.why}</p>
                  </div>
                  <span className={`pill ${r.paid ? "green" : ""}`}>{r.paid ? "Gets paid" : "Not paid"}</span>
                </li>
              ))}
            </ul>
          </figure>
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
            <p>Prove you run your repository and choose where PayPal should send your payouts. It takes about two minutes.</p>
            <Link className="btn" to="/claim"><BadgeCheck size={15} />Claim your project</Link>
          </div>
        </section>
      </main>

      <footer className="home-foot">
        <span>{brand}. Open source under the MIT license.</span>
        <span className="row" style={{ gap: 16 }}>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">GitHub</a>
          {!user && <Link to="/unlock">{available ? "Sign in with a token" : "Admin token"}</Link>}
        </span>
      </footer>
    </div>
  );
}
