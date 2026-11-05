# Upstream

**Your AI coding agent pays the open-source maintainers it actually relied on, through PayPal.**

Dependency lists can't tell the library your agent leaned on all afternoon from one nobody touched. Upstream records what a coding agent *really did* in a session: packages installed, code written against a library's API, library source studied, docs read. Muse Spark weighs that evidence and must cite it, and code throws out anything it can't back up. Maintainers who prove they run the repository are then paid through **PayPal Payouts**, from a budget each person approves on PayPal's own page.

> Built for *Build What's Next with PayPal and AI* (Devpost, 2026). PayPal sandbox only, so no real money moves. MIT licensed. First commit: Oct 11, 2026.

### What's proven so far

| Claim | Evidence |
|---|---|
| The AI finds what dependency lists miss | Live `muse-spark-1.3` on 12 scripted scenarios, 3 runs each: 12 of 12 correct, against 7 of 12 for counting imports, including rewritten logic and code added to an existing import. Same result on every run. [Results and limits](docs/BENCHMARK.md), and you can [re-run it](scripts/benchmark.mjs). The scenarios and answers were written by this project, so it's a sanity check rather than an accuracy figure |
| A README can't talk the AI into paying it | A package whose README demanded all the money got nothing, and the AI flagged the attempt in 3 of 3 runs |
| Code overrules the AI | 9 of 9 deliberately malicious AI outputs were blocked: invented packages, made-up evidence, payments to packages merely listed, and more |
| The whole loop works end to end | A real Claude Code session with the real hook, then a live Muse review, a maintainer claim verified from the repo on GitHub, and a real sandbox payout: batch `D85JLLSK5RWHN`, $3.59 sent (transaction `98L012548L1896315`), PayPal's $0.25 fee recorded. Sending it twice paid once, PayPal rejected a replay, and PayPal's webhooks arrived with valid signatures |
| Real PayPal funding | Sandbox subscription `I-743R8NEH7WYM`: $10.00 paid, PayPal's $0.84 fee recorded |
| People's money and data stay apart | [Tests](server/test/workspaces.test.ts) act as one person attacking another over HTTP, and a real two-person run on the sandbox and live AI leaked nothing |

**Not done yet, stated plainly:** that run is one session, and the payout went to a test package this project owns (`split-cents`), so it proves the system works, not that anyone outside wants it. `split-cents` isn't on npm yet, so its repo link came from its own `package.json`, and the dashboard labels it that way. A one-time top-up hasn't been approved through PayPal, Log in with PayPal is off, and cancelling an unclaimed payout and refunds have only been tested against a stand-in for PayPal. No real labelled sessions are on the AI accuracy page yet. There's no permanent hosted demo, so trying it means running it locally.

---

## The problem

- Tidelift's 2024 maintainer survey: **60%** of maintainers call themselves *unpaid hobbyists*, and **47%** say they are *unpaid for their work*. Tidelift attributes the gap to wording: some "hobbyists" receive token amounts. ([The Register](https://www.theregister.com/2024/09/18/open_source_maintainers_underpaid/), [Tidelift press release](https://www.businesswire.com/news/home/20240917030299/en/))
- Existing funding tools split money by **dependency manifests** ([thanks.dev](https://thanks.dev), [ecosyste.ms Funds](https://funds.ecosyste.ms), and earlier [StackAid](https://itsfoss.com/news/stackaid-beta/), launched in 2022). A manifest can't tell the library your agent leaned on all afternoon from a dependency nobody touched.
- AI-assisted development consumes open-source work heavily and has no feedback loop to maintainers. (The well-known infrastructure costs, such as Read the Docs' 73 TB month and Fedora blocking a whole country, come from *training crawlers*, not coding agents. We cite them only as context and don't claim coding agents caused them.)

**Who it's for:** developers and teams who use AI coding agents daily and want an honest, low-effort way to give back, and the maintainers whose code those agents use. The strongest long-term fit is companies that already budget for open source and want an auditable reason for each payment, running their own copy with their own PayPal account.

## What it does

```
Claude Code ──hooks──► evidence (installs, imports + lines using them, API use, library source read, docs, MCP doc lookups)
                         │  secrets redacted on the developer's machine
                         ▼
              candidates per session: used · docs-only · merely present
                         ▼
     Muse Spark (structured output) proposes weights + cites evidence ids
                         ▼
     validator (code): drop hallucinated / uncited / merely-present, normalise, per-package cap
                         ▼
     deps.dev + ecosyste.ms + FUNDING.yml ─► repo ─► verified maintainer claim (GitHub admin/maintain or FUNDING.yml token)
                         ▼
     settlement (code): budget = PayPal-confirmed funds − fee reserve; caps; min/max item; unclaimed repos held
                         ▼
     human approves ─► PayPal Payouts batch (fixed sender_batch_id + PayPal-Request-Id)
                         ▼
     verified webhooks + hourly reconciler ─► ledger (actual PayPal fees, UNCLAIMED → cancel → returned → re-held)
```

Where people use it:

| Surface | For | What you do there |
|---|---|---|
| **Agent hook + MCP server** | the developer's coding agent | Hooks capture evidence automatically. The optional MCP server gives the agent a guarded Payouts tool. |
| **Private dashboard** | anyone who signs in with GitHub | Fund with PayPal, review sessions, approve and send payouts, check the money records, measure the AI. |
| **Maintainer claim page** | open-source maintainers | Prove you control a repo, then register a PayPal email. Public, no Upstream account needed. |
| **Public repo page + README badge** | maintainers and their users | `/r/owner/name` shows what agents relied on and what is held, paid or in flight; `/api/badge/owner/name.svg` puts "$X waiting · claim it" in a README. |

## How it meets the hackathon requirements

| Requirement | Upstream |
|---|---|
| Meaningfully integrate PayPal | Subscriptions (catalog product, plan, subscription, transactions), Orders v2 one-time top-ups (create, capture, read; fees and refunds from PayPal's own numbers), Log in with PayPal for maintainers' verified payout email, Payouts (create batch, show batch, show item, cancel unclaimed item), Webhooks (create/patch subscription, `verify-webhook-signature`), OAuth2 client credentials. Money only moves through PayPal. |
| Meaningfully incorporate AI | Muse Spark turns raw session evidence into cited value weights, which is the core judgement of the product. Its output is measured against a deterministic baseline on sessions *you* label (Eval page). |
| Working prototype | Runs locally (see [Run it locally](#run-it-locally)), with `render.yaml` for hosting. No mock data or mock fallbacks: a missing credential disables that feature and the UI says which. |
| Documented | This README, `.env.example`, and inline docs in the code. |
| Tools identified | See [Tools used](#tools-used). |

**Novelty, stated honestly.** Funding open source from dependency trees exists (thanks.dev, StackAid, Open Source Pledge, ecosyste.ms Funds). Asking agents to *credit* maintainers exists as a draft spec ([ATTRIBUTION.md v0.1](https://github.com/attributionmd/attribution.md): stars only, no money). What we did not find anywhere is **paying maintainers from evidence of runtime agent usage**, separating "used" from "merely present". That evidence layer is Upstream's contribution. A guarded Payouts tool on its own is not new: other entries put policies in front of Payouts.

## PayPal integration (all sandbox)

| API | Calls | Where |
|---|---|---|
| OAuth2 | `POST /v1/oauth2/token` (cached until expiry) | `server/src/paypal/client.ts` |
| Catalog Products | `POST /v1/catalogs/products` | `server/src/paypal/subscriptions.ts` |
| Subscriptions | `POST /v1/billing/plans`, `POST /v1/billing/subscriptions` (approve link), `GET /v1/billing/subscriptions/{id}`, `GET …/{id}/transactions` | `subscriptions.ts`, `funding.ts` |
| Payouts | `POST /v1/payments/payouts`, `GET /v1/payments/payouts/{id}` (all pages), `GET /v1/payments/payouts-item/{id}`, `POST /v1/payments/payouts-item/{id}/cancel` | `payouts.ts`, `settlement.ts` |
| Orders v2 | `POST /v2/checkout/orders` (intent CAPTURE, `payment_source.paypal.experience_context`), `POST /v2/checkout/orders/{id}/capture` and `GET /v2/checkout/orders/{id}` with `Prefer: return=representation` | `paypal/orders.ts`, `topups.ts` |
| Identity (Log in with PayPal) | `/connect` authorize page, `POST /v1/oauth2/token` (`grant_type=authorization_code`), `GET /v1/identity/openidconnect/userinfo` (falls back to `/v1/identity/oauth2/userinfo`, the path the integration guide shows) | `paypal/identity.ts`, `claims.ts` |
| Webhooks | `GET/POST/PATCH /v1/notifications/webhooks`, `POST /v1/notifications/verify-webhook-signature` (raw body spliced in byte-for-byte) | `webhooks.ts`, `events.ts` |

Details that matter:

- **Idempotency.** Every batch has `sender_batch_id = upstream-<settlement id>`. PayPal rejects reuse within 30 days and completes a payment only once per `sender_batch_id`, so a retry after a 5xx is safe. The request body is frozen at approval, and the same id is sent as `PayPal-Request-Id`. **Replay batch** re-sends the identical body with a *new* request id and shows PayPal's real rejection.
- **Unclaimed money.** PayPal returns unclaimed payouts after 30 days unless cancelled. Upstream cancels `UNCLAIMED` items after `POLICY_CANCEL_UNCLAIMED_AFTER_DAYS` (or on demand), books the return, re-holds the money for that repo, and flags the claim so the maintainer can fix their email.
- **Fees are real numbers.** Funding fees come from the subscription transaction's `fee_amount`, and payout fees from each item's `payout_item_fee`. A configurable fee *reserve* keeps the budget safe until PayPal reports the actual fee; that reserve shrinks as fees arrive.
- **Webhooks never move money directly.** Events are signature-verified, stored, and processed idempotently. Funding events only trigger a pull of PayPal's transaction list (one source of truth). Batch events, which carry no item data, trigger a batch read. Refunds and reversals (`PAYMENT.SALE.REFUNDED` / `REVERSED`) trigger the same pull. `CHECKOUT.ORDER.APPROVED` captures a top-up whose payer closed the tab, and `PAYMENT.CAPTURE.*` events trigger a read of the order. An hourly reconciler re-reads open batches, subscription transactions and recent top-ups, so nothing depends on a webhook arriving.
- **One-time top-ups.** Gross and `paypal_fee` come from the capture's `seller_receivable_breakdown`; a refund books its gross out and the fee PayPal hands back in (`seller_payable_breakdown`). The capture uses a fixed `PayPal-Request-Id`, so returning twice or a late webhook never captures twice. `POLICY_MAX_TOPUP` caps dashboard top-ups. A chargeback (`PAYMENT.CAPTURE.REVERSED`) is flagged for review, not booked, because PayPal's docs don't show how it appears on the order.
- **Verified payout email.** With `PAYPAL_LOGIN_ENABLED=true`, maintainers can connect their PayPal account instead of typing an email: Upstream reads `email` and `email_verified` from Identity v1, refuses an unverified email, and doesn't store the user's PayPal token. The userinfo response has no payer id, so payouts still use `recipient_type` EMAIL, now with an email PayPal verified.
- **Agent tool.** PayPal's Agent Toolkit lists catalog, disputes, invoices, orders/payments, reporting, shipment tracking and subscriptions, but no Payouts. `mcp/` adds `upstream_plan_payout`, `upstream_send_approved_payout`, `upstream_payout_status`, `upstream_session_credits` (PR credits Markdown) and `upstream_request_funding`. The model can never choose receivers or amounts, can only send a batch a human approved, and a funding request only returns a PayPal link the user approves, capped per 24 hours by `POLICY_MAX_AGENT_TOPUP` (off when unset).

## AI: what Muse Spark does and how we keep it honest

- **Attribution** (`server/src/attribution/llm.ts`): Meta's Model API through its Anthropic-format Messages endpoint (`POST https://api.meta.ai/v1/messages`), called with the Anthropic SDK and a JSON schema built from Zod (`zodOutputFormat`). The model comes from `UPSTREAM_MODEL` (default `muse-spark-1.3`, a Standard model, whose content Meta says it does not use for training). Muse Spark classifies each candidate as meaningful, supporting, incidental or not used, assigns a relative weight, writes a one-to-two-sentence rationale a maintainer can read, and **must cite evidence ids**. The system prompt treats all session content as data, so a README asking for credit is ignored.
- **Validator** (`validate.ts`), applied in code after the model:
  - drops packages that aren't candidates;
  - drops citations that don't exist;
  - zeroes any weight not backed by evidence linked to that package (so "merely present" can never be paid);
  - normalises the weights and enforces `POLICY_MAX_PACKAGE_SHARE`;
  - flags weak-evidence/high-weight, strong-but-unpaid, and large divergence from the baseline.
- **Baseline** (`baseline.ts`): *imports written × lines using them*, the simple heuristic the AI has to beat.
- **Eval** (`eval.ts`, Eval page): label packages in real sessions as meaningful, incidental or not used. Upstream then reports precision, recall, F1, accuracy and weight error (L1) for Muse Spark and the baseline **on the same sessions**. Labels saved before any attribution ran are marked **blind** by the server (from stored timestamps), and the page can score blind sessions on their own, so the labeller can't have been nudged by either method's weights. Nothing is precomputed; with no labels, the page says so.

Why the baseline isn't enough, from the [benchmark](docs/BENCHMARK.md): when an agent adds code to a file that already imports `dayjs`, or studies `lodash/debounce.js` and writes its own debounce, import counting pays nothing. It also pays for an import nobody uses. Muse Spark got these right, though on scenarios this project wrote, so real sessions on the AI accuracy page are the test that counts.

## The evidence layer (the crux)

The collector is a Claude Code **hook** (`hook/upstream-hook.mjs`), not a tool the agent has to choose to call. Hooks see every tool call (`PostToolUse` delivers `tool_name`, `tool_input`, `tool_response` and `transcript_path`).

| Evidence | Detected from |
|---|---|
| `dep_install` | `npm/pnpm/yarn/bun add`, `pip/uv/poetry/pdm add`, `python -m pip install` |
| `manifest_add` | Edits that add entries to `package.json`, `requirements*.txt`, `pyproject.toml` (PEP 621, poetry, dependency groups) |
| `import_added` | New `import`/`require`/`from … import` in written code, with the number of added lines using those bindings (type-only imports are weak) |
| `api_usage` | New code using a package already imported in that file (the hook attaches the file's first 8 KB) |
| `cli_run` | `npx`, `bunx`, `pnpm dlx`, `uvx`, `pipx run` |
| `logic_reused` | After reading a package's source, the agent wrote its own code declaring the same names. Only the matching names are kept. Catches rewritten logic that no import reveals, and it can be fooled by a coincidental name, so the review judges it |
| `source_read` / `source_search` | Read/Grep/Glob inside `node_modules/<pkg>` or `site-packages/<module>` (a short excerpt is kept, which `logic_reused` compares against) |
| `docs_fetch` | WebFetch URLs: npmjs.com, pypi.org, GitHub, unpkg/jsDelivr, or a host matching the package's resolved homepage/docs |
| `docs_mcp` | Context7 `resolve-library-id` / `query-docs` calls |
| `web_search` | Package name appearing in a search query (weak) |

Python import names are mapped to distributions (`yaml` → PyYAML, `PIL` → pillow) with `importlib.metadata.packages_distributions()` on the developer's machine, using the project's `.venv` when there is one. That call reads every installed distribution and can take several seconds, so the hook caches the map per interpreter and only recomputes it when a `sys.path` directory changes. The installer computes it once up front, so the first session already gets a cache hit. `SessionStart` sends it, and `Stop` resends it if packages were installed mid-session. The current directory is removed from `sys.path` first, so a project file such as `json.py` never runs inside the hook. Node built-ins come from `module.builtinModules`. Manifests are snapshotted at `SessionStart` and `Stop`, so "added this session" is a diff, not a guess.

**Privacy:** files that look like secrets (`.env*`, keys, credentials, `.npmrc`/`.pypirc`) are redacted before anything leaves the machine. Reads of your own files send only the path. Events go only to the server you configure, and are spooled locally when it's offline.

## Explainability and the maintainer loop

- **Money trail.** For any repo, the dashboard opens every allocation, the sessions behind it, each session's validated weight with Muse Spark's rationale, the evidence ids it cites, and the PayPal payout items (`GET /api/trail?repo=github.com/owner/name`). Nothing is recomputed for display.
- **Session receipt.** Each attributed session gets a plain-language receipt and a *Copy credits for your PR* button: a Markdown table of packages, roles, shares and reasons, in the spirit of ATTRIBUTION.md.
- **Public repo page and badge.** `/r/owner/name` and `/api/badge/owner/name.svg` (`public.ts`) show held, in-flight and paid totals, how many agent sessions relied on the repo, **how the maintainer proved control** (GitHub permission level, or the FUNDING.yml file and claim link anyone can re-check), and each payout PayPal reported with its **PayPal transaction id**, so the maintainer can find it in their own PayPal activity. Projects and payout emails are never public. Unclaimed repos get an *Invite* link on the Packages page, and the claim page lists repos with money waiting.

## Trust: what you don't have to take on faith

- **A private space for each person.** Anyone can sign in with GitHub and gets their own sessions, budget, money records, payouts, safety checks and agent token. Other people's records answer "not found", a person can only spend money they funded, and hourly reconciliation books each payment to its owner (`server/test/workspaces.test.ts` attacks this over HTTP). Packages and maintainer claims are shared, so a maintainer verifies once for everyone. Each person's AI reviews are capped per day because the server pays for them. Maintainer pages (`/claim`, `/r/owner/name`, the badge) are public, and `DASHBOARD_ACCESS=public` shows the operator's space to anyone as a read-only demo.
- **Live audit** (`server/src/audit.ts`, `GET /api/audit`, *Safety checks* page). Ten checks re-read the stored records on every request: every ledger entry points at a PayPal object; held plus in-flight money is covered by the PayPal-confirmed balance; every payout went to a maintainer verified before approval, with stored proof; each payout item equals its allocations to the cent; the ledger agrees with each item's PayPal status (sent, fee and return booked exactly once); items respect the caps recorded with their run; only signature-verified webhooks changed anything; every paid share cites evidence that exists in the evidence table; every allocation traces to sessions whose attribution pays that package; unfinished batches were re-read from PayPal in the last 2 hours. A check with nothing to examine reports *nothing to check yet*, never a pass, and the page says so plainly when the server hasn't called PayPal or Muse Spark yet. `server/test/audit.test.ts` runs a real payout through the settlement code, expects every check to pass, then alters one record at a time and expects the matching check to fail.
- **Locked history.** Once a session is in a payout, its attribution can't be re-run or swapped, so the money trail can't be rewritten after the fact. A claim's `verified_at` records when ownership was first proven; a replaced or revoked claim can't come back.

## Maintainer claims (ownership proof)

deps.dev itself notes its package→repo links "are not verified for correctness", so a link alone never releases money. A repo becomes payable only through one of these:

1. **GitHub OAuth.** We call `GET /repos/{owner}/{repo}` with the maintainer's token and require `permissions.admin` or `permissions.maintain` (scope requested: `read:org`; no write access).
2. **FUNDING.yml token.** We issue a link and the maintainer commits it as a `custom:` entry in the repo's FUNDING.yml (GitHub allows up to four). Seeing it on the default branch proves write access. The token is public by design, so it can't be used to change the payout email.

Shares for repos nobody has claimed are **held** for `POLICY_RESERVE_DAYS`, then released back to the funder's pool. Upstream never sends money to an unverified address.

## Run it locally

Requires **Node.js ≥ 22.18** (built-in SQLite and TypeScript type stripping, so there is no native build and no compile step). Python is optional: it's only used for import→distribution mapping in Python projects.

```bash
git clone https://github.com/PROSTLE/Upstream upstream && cd upstream
npm install
cp .env.example .env        # fill in the values below
npm run doctor              # live, read-only check of every credential and external API
npm run build               # builds the dashboard
npm run setup:paypal        # creates the sandbox product, plan and (if PUBLIC_BASE_URL is https) the webhook
npm start                   # http://localhost:8787
```

`.env` essentials:

| Variable | Where to get it |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | developer.paypal.com → Apps & Credentials → **Sandbox** app |
| `MODEL_API_KEY` | dev.meta.ai → API keys |
| `ADMIN_TOKEN`, `INGEST_TOKEN` | any long random strings, e.g. `node -e "console.log(crypto.randomUUID())"` |
| `GITHUB_TOKEN` | optional but recommended: anonymous GitHub API access is 60 requests/hour, which FUNDING.yml lookups exhaust quickly. A fine-grained token with public read access is enough |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → OAuth Apps. Add two callbacks: `PUBLIC_BASE_URL/api/auth/github/callback` and `PUBLIC_BASE_URL/api/claims/github/callback` |
| `OPERATOR_GITHUB_LOGINS` | your GitHub login. It owns any data from before accounts existed and the server-wide tasks. Everyone else who signs in gets their own space |
| `PUBLIC_BASE_URL` | your https URL. PayPal only delivers webhooks to https, so use Render or a tunnel such as `cloudflared tunnel --url http://localhost:8787` |

For development, `npm run dev` runs the API with `--watch` and Vite on http://localhost:5173.

Connect Claude Code: sign in, open **Connect your agent**, and copy the command, which is already filled in with your own token. It installs the hooks into a project. The same page has a **Claude Code plugin** option that adds slash commands and keeps your token in Claude Code's secure storage.

### Testing instructions for judges

**In 2 minutes, without installing anything:** read [What's proven so far](#whats-proven-so-far) and the [benchmark](docs/BENCHMARK.md), then look at [the check that stops one person reaching another's data](server/test/workspaces.test.ts) and [what code does to the AI's proposal](server/src/attribution/validate.ts).

**In about 15 minutes, on your own machine** (you need a PayPal sandbox app, a Meta Model API key, a GitHub OAuth app and Claude Code):

1. **Sign in** with GitHub. You get your own empty space, with one clear next step on the Overview page.
2. **Add funds.** *Add funds* page → approve with PayPal, logging in with a sandbox *personal* account (create one in the PayPal Developer Dashboard). *Sync from PayPal* records the payment and PayPal's fee. Or add money once: approve a one-time payment and Upstream captures it on return.
3. **Code.** Run the command from *Connect your agent*, then run a short Claude Code session (for example "add input validation with zod"). It appears under *Coding sessions* as it happens.
4. **Review.** On the session page, you can first mark which packages really mattered under *Your ground truth* (labels saved before the review count as blind). Then click *Review with Muse Spark* and compare it with the Baseline tab.
5. **Claim.** Open `/claim` and claim a GitHub repo **you** administer, entering the sandbox personal email.
6. **Pay.** *Pay maintainers* → *Plan payout* → review the checks → *Approve* → *Send with PayPal Payouts* → *Sync from PayPal*. Try *Replay batch* to see PayPal reject the duplicate, and *Cancel* on an `UNCLAIMED` item (send to an email with no sandbox account to produce one).
7. **Check.** *Money records* shows every PayPal-confirmed movement and your API calls. *Safety checks* re-checks your records against the payout rules.

`ADMIN_TOKEN` is only the operator's fallback for scripts and for servers without GitHub sign-in. The claim page and repo pages need no sign-in.

## Deploy on Render

`render.yaml` defines one web service with a 1 GB persistent disk for SQLite. Accounts and money records live there, so this needs a paid instance: the free plan has no disk and can wipe them on restart. It generates `ADMIN_TOKEN` and `INGEST_TOKEN` and prompts for secrets. After the first deploy, set `PUBLIC_BASE_URL` to the service URL and run `npm run doctor` and then `npm run setup:paypal` from the Render shell to register the webhook. The server also reconciles open batches hourly by itself.

## Tests

```bash
npm test          # 61 tests: parsers, evidence extraction, validator, money math, the hook script and its spool, public repo views and badge,
                  # top-ups (capture, fees, refunds, retries, agent cap), Log in with PayPal, PR credits, the plugin manifest, an end-to-end settlement,
                  # claim and settlement state guards, the safety checks (pass on real records, fail on altered ones), sign-in, and one person attacking another over HTTP
node scripts/benchmark.mjs   # re-runs docs/BENCHMARK.md against the live AI model, about $0.30
npm run doctor    # live, read-only checks against PayPal, Muse Spark, GitHub, deps.dev and ecosyste.ms (needs .env)
npm run typecheck
npm run icons     # re-render the favicon and app icons from the one vector mark (scripts/icons.mjs)
```

The settlement test drives plan → approve → execute twice (exactly one PayPal POST) → replay (rejected) → UNCLAIMED → cancel → returned and re-held, against an in-process stand-in for PayPal's HTTP API. That stand-in exists only in the test file; the product always talks to PayPal.

## Tools used

| Tool | How it's used |
|---|---|
| **Muse Spark** (`muse-spark-1.3` on Meta's Model API, through its Anthropic-format Messages endpoint with the Anthropic TypeScript SDK) | Runtime: evidence-based value attribution with structured output. |
| **Claude Code hooks** | Runtime: the evidence collector (`PostToolUse`, `SessionStart`, `Stop`, `SessionEnd`). |
| **Claude Code plugin** | Packaging: `.claude-plugin/plugin.json` bundles the hooks, the MCP server and three skills, with `userConfig` for the URL and tokens. |
| **Model Context Protocol** (`@modelcontextprotocol/sdk`) | Runtime: Upstream's MCP server exposing guarded Payouts actions to agents. |
| **PayPal REST APIs** (sandbox) | Subscriptions, Orders v2, Payouts, Webhooks and Identity (Log in with PayPal), as listed above. |
| **deps.dev API v3**, **ecosyste.ms Packages API**, **npm registry**, **GitHub REST API** | Package → repo, funding links, FUNDING.yml, repo permissions, and Sign in with GitHub. |
| **AG Grid Community** + **AG Charts Community** | Sessions, packages, payout items, allocations, ledger and API-audit grids; attribution and eval charts. |
| **Render** | Optional hosting via `render.yaml`. |
| Lucide, Simple Icons, Inter, JetBrains Mono | UI icons and type. The PayPal mark is PayPal's own file from paypalobjects.com. |
| **resvg** (`@resvg/resvg-js`) | Build time: renders the app icons from the hand-drawn SVG mark. |
| **Claude Code** (as a coding assistant) | Used to help write this project, including its benchmark scenarios. |

## Limitations (on purpose, in the open)

- **Regulation.** All funds pass through one PayPal business account. Each person's records are kept apart and they can only spend what they funded, but holding and redistributing other people's money resembles a marketplace or money-transmission flow and needs legal review before real use. Live Payouts also needs PayPal to enable it on the account. This project is sandbox-only, and in live mode only the operator can move money.
- **Demand.** Nobody has yet shown they'd pay for this. The problem is well documented, but willingness to fund it is the biggest open question.
- **The operator can read the database.** Sessions are private between users in the app, but whoever runs the server holds the data, so only connect a server you trust.
- **Ecosystems.** npm and PyPI only. Claims are GitHub-only.
- **Evidence limits.** Code the agent writes from memory, without installing, importing, reading source or docs, leaves no trace. `logic_reused` matches declared names, so renamed logic goes unseen and a coincidental name can trigger it. Unlabelled sessions have no accuracy guarantee; that's why the eval exists.
- **Partial refunds** of a subscription payment are flagged but not booked, because the transaction list doesn't break out the refunded amount.
- **Per-package cap.** In a session where one package did everything, the cap deliberately leaves the rest of that session's slice in the pool.

## Sources

PayPal: [Payouts API](https://developer.paypal.com/docs/api/payments.payouts-batch/v1/) and [schema](https://developer.paypal.com/api/payments.payouts-batch/v1/schema.json) · [Cancel unclaimed payouts](https://developer.paypal.com/payouts/use-payouts/cancel-reverse-payouts) · [Webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/) · [Verify webhook signature](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post) · [Subscriptions API](https://developer.paypal.com/docs/api/subscriptions/v1/) · [Payouts fees](https://developer.paypal.com/payouts/fees) · [Agent Toolkit](https://github.com/paypal/agent-toolkit) · [MCP server](https://developer.paypal.com/tools/mcp-server/)
Data: [deps.dev API v3](https://docs.deps.dev/api/v3/) · [ecosyste.ms](https://ecosyste.ms/api) · [GitHub FUNDING.yml](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository) · [GitHub repos API](https://docs.github.com/en/rest/repos/repos)
Agents: [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Context7](https://github.com/upstash/context7) · [ATTRIBUTION.md](https://github.com/attributionmd/attribution.md) · [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
Context: [Tidelift 2024 (The Register)](https://www.theregister.com/2024/09/18/open_source_maintainers_underpaid/) · [Read the Docs on AI crawlers](https://about.readthedocs.com/blog/2024/07/ai-crawlers-abuse/) · [StackAid (2022)](https://itsfoss.com/news/stackaid-beta/) · [thanks.dev](https://thanks.dev) · [ecosyste.ms Funds](https://funds.ecosyste.ms)

## License

[MIT](LICENSE)
