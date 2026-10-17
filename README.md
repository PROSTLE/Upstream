# Upstream

**Your AI coding agent pays the open-source maintainers it actually relied on, through PayPal.**

Upstream records what a coding agent *really did* in a session (packages installed, code written against a library's API, library source studied, docs read). Claude weighs that evidence; deterministic code then checks every weight. The result is paid to maintainers who have proven they control the repository, using **PayPal Payouts**. Funding comes from a fixed monthly "agent tithe" the developer approves once with **PayPal Subscriptions**.

> Built for *Build What's Next with PayPal and AI* (Devpost, 2026). PayPal sandbox only. MIT licensed.

---

## The problem

- Tidelift's 2024 maintainer survey: **60%** of maintainers call themselves *unpaid hobbyists*, and **47%** say they are *unpaid for their work*. Tidelift attributes the gap to wording: some "hobbyists" receive token amounts. ([The Register](https://www.theregister.com/2024/09/18/open_source_maintainers_underpaid/), [Tidelift press release](https://www.businesswire.com/news/home/20240917030299/en/))
- Existing funding tools split money by **dependency manifests** ([thanks.dev](https://thanks.dev), [ecosyste.ms Funds](https://funds.ecosyste.ms), and earlier [StackAid](https://itsfoss.com/news/stackaid-beta/), launched in 2022). A manifest can't tell the library your agent leaned on all afternoon from a dependency nobody touched.
- AI-assisted development consumes open-source work heavily and has no feedback loop to maintainers. (The well-known infrastructure costs, such as Read the Docs' 73 TB month and Fedora blocking a whole country, come from *training crawlers*, not coding agents. We cite them only as context and don't claim coding agents caused them.)

**Who it's for:** developers and teams who use AI coding agents daily and want an honest, low-effort way to give back. Also the maintainers whose code those agents use.

## What it does

```
Claude Code ──hooks──► evidence (installs, imports + lines using them, API use, library source read, docs, MCP doc lookups)
                         │  secrets redacted on the developer's machine
                         ▼
              candidates per session: used · docs-only · merely present
                         ▼
     Claude (structured output) proposes weights + cites evidence ids
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

Three surfaces:

| Surface | For | What you do there |
|---|---|---|
| **Agent hook + MCP server** | the developer's coding agent | Hooks capture evidence automatically. The optional MCP server gives the agent a guarded Payouts tool. |
| **Funder dashboard** | the developer or team | Fund with PayPal, review sessions and attribution, approve and send payouts, reconcile the ledger, run the eval. |
| **Maintainer claim page** | open-source maintainers | Prove you control a repo, then register a PayPal email. Public, no Upstream account needed. |

## How it meets the hackathon requirements

| Requirement | Upstream |
|---|---|
| Meaningfully integrate PayPal | Subscriptions (catalog product, plan, subscription, transactions), Payouts (create batch, show batch, show item, cancel unclaimed item), Webhooks (create/patch subscription, `verify-webhook-signature`), OAuth2 client credentials. Money only moves through PayPal. |
| Meaningfully incorporate AI | Claude turns raw session evidence into cited value weights, which is the core judgement of the product. Its output is measured against a deterministic baseline on sessions *you* label (Eval page). |
| Working prototype | Runs locally with one command, or on Render (`render.yaml`). No mock data or mock fallbacks: a missing credential disables that feature and the UI says which. |
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
| Webhooks | `GET/POST/PATCH /v1/notifications/webhooks`, `POST /v1/notifications/verify-webhook-signature` (raw body spliced in byte-for-byte) | `webhooks.ts`, `events.ts` |

Details that matter:

- **Idempotency.** Every batch has `sender_batch_id = upstream-<settlement id>`. PayPal rejects reuse within 30 days and completes a payment only once per `sender_batch_id`, so a retry after a 5xx is safe. The request body is frozen at approval, and the same id is sent as `PayPal-Request-Id`. **Replay batch** re-sends the identical body with a *new* request id and shows PayPal's real rejection.
- **Unclaimed money.** PayPal returns unclaimed payouts after 30 days unless cancelled. Upstream cancels `UNCLAIMED` items after `POLICY_CANCEL_UNCLAIMED_AFTER_DAYS` (or on demand), books the return, re-holds the money for that repo, and flags the claim so the maintainer can fix their email.
- **Fees are real numbers.** Funding fees come from the subscription transaction's `fee_amount`, and payout fees from each item's `payout_item_fee`. A configurable fee *reserve* keeps the budget safe until PayPal reports the actual fee; that reserve shrinks as fees arrive.
- **Webhooks never move money directly.** Events are signature-verified, stored, and processed idempotently. Funding events only trigger a pull of PayPal's transaction list (one source of truth). Batch events, which carry no item data, trigger a batch read. Refunds and reversals (`PAYMENT.SALE.REFUNDED` / `REVERSED`) trigger the same pull. An hourly reconciler re-reads open batches *and* subscription transactions, so nothing depends on a webhook arriving.
- **Agent tool.** PayPal's Agent Toolkit lists catalog, disputes, invoices, orders/payments, reporting, shipment tracking and subscriptions, but no Payouts. `mcp/` adds `upstream_plan_payout`, `upstream_send_approved_payout` and `upstream_payout_status`. The model can never choose receivers or amounts, and can only send a batch a human approved.

## AI: what Claude does and how we keep it honest

- **Attribution** (`server/src/attribution/llm.ts`): `client.beta.messages.parse` with a Zod schema (`betaZodOutputFormat`), model from `UPSTREAM_MODEL` (default `claude-opus-5-5`), adaptive thinking, and `fallbacks: "default"`. Claude classifies each candidate as meaningful, supporting, incidental or not used, assigns a relative weight, writes a one-to-two-sentence rationale a maintainer can read, and **must cite evidence ids**. The system prompt treats all session content as data, so a README asking for credit is ignored.
- **Validator** (`validate.ts`), applied in code after the model:
  - drops packages that aren't candidates;
  - drops citations that don't exist;
  - zeroes any weight not backed by evidence linked to that package (so "merely present" can never be paid);
  - normalises the weights and enforces `POLICY_MAX_PACKAGE_SHARE`;
  - flags weak-evidence/high-weight, strong-but-unpaid, and large divergence from the baseline.
- **Baseline** (`baseline.ts`): *imports written × lines using them*, the simple heuristic the AI has to beat.
- **Eval** (`eval.ts`, Eval page): label packages in real sessions as meaningful, incidental or not used. Upstream then reports precision, recall, F1, accuracy and weight error (L1) for Claude and the baseline **on the same sessions**. Labels saved before any attribution ran are marked **blind** by the server (from stored timestamps), and the page can score blind sessions on their own, so the labeller can't have been nudged by either method's weights. Nothing is precomputed; with no labels, the page says so.

Why the baseline isn't enough, from this repo's smoke test (Claude Code-shaped events piped through the real hook and server, not yet a live Claude Code session): the agent added code against an existing `dayjs` import, and studied `lodash/debounce.js` before writing its own debounce. Import counting gives both **0%**. Catching that kind of use (API use without a new import, reimplementation after reading source) is what the LLM step is for, and the eval measures whether it actually does.

## The evidence layer (the crux)

The collector is a Claude Code **hook** (`hook/upstream-hook.mjs`), not a tool the agent has to choose to call. Hooks see every tool call (`PostToolUse` delivers `tool_name`, `tool_input`, `tool_response` and `transcript_path`).

| Evidence | Detected from |
|---|---|
| `dep_install` | `npm/pnpm/yarn/bun add`, `pip/uv/poetry/pdm add`, `python -m pip install` |
| `manifest_add` | Edits that add entries to `package.json`, `requirements*.txt`, `pyproject.toml` (PEP 621, poetry, dependency groups) |
| `import_added` | New `import`/`require`/`from … import` in written code, with the number of added lines using those bindings (type-only imports are weak) |
| `api_usage` | New code using a package already imported in that file (the hook attaches the file's first 8 KB) |
| `cli_run` | `npx`, `bunx`, `pnpm dlx`, `uvx`, `pipx run` |
| `source_read` / `source_search` | Read/Grep/Glob inside `node_modules/<pkg>` or `site-packages/<module>` (excerpt kept for reimplementation checks) |
| `docs_fetch` | WebFetch URLs: npmjs.com, pypi.org, GitHub, unpkg/jsDelivr, or a host matching the package's resolved homepage/docs |
| `docs_mcp` | Context7 `resolve-library-id` / `query-docs` calls |
| `web_search` | Package name appearing in a search query (weak) |

Python import names are mapped to distributions (`yaml` → PyYAML, `PIL` → pillow) with `importlib.metadata.packages_distributions()` on the developer's machine, using the project's `.venv` when there is one. That call reads every installed distribution and can take several seconds, so the hook caches the map per interpreter and only recomputes it when a `sys.path` directory changes. The installer computes it once up front, so the first session already gets a cache hit. `SessionStart` sends it, and `Stop` resends it if packages were installed mid-session. The current directory is removed from `sys.path` first, so a project file such as `json.py` never runs inside the hook. Node built-ins come from `module.builtinModules`. Manifests are snapshotted at `SessionStart` and `Stop`, so "added this session" is a diff, not a guess.

**Privacy:** files that look like secrets (`.env*`, keys, credentials, `.npmrc`/`.pypirc`) are redacted before anything leaves the machine. Reads of your own files send only the path. Events go only to the server you configure, and are spooled locally when it's offline.

## Maintainer claims (ownership proof)

deps.dev itself notes its package→repo links "are not verified for correctness", so a link alone never releases money. A repo becomes payable only through one of these:

1. **GitHub OAuth.** We call `GET /repos/{owner}/{repo}` with the maintainer's token and require `permissions.admin` or `permissions.maintain` (scope requested: `read:org`; no write access).
2. **FUNDING.yml token.** We issue a link and the maintainer commits it as a `custom:` entry in the repo's FUNDING.yml (GitHub allows up to four). Seeing it on the default branch proves write access. The token is public by design, so it can't be used to change the payout email.

Shares for repos nobody has claimed are **held** for `POLICY_RESERVE_DAYS`, then released back to the funder's pool. Upstream never sends money to an unverified address.

## Run it locally

Requires **Node.js ≥ 22.18** (built-in SQLite and TypeScript type stripping, so there is no native build and no compile step). Python is optional: it's only used for import→distribution mapping in Python projects.

```bash
git clone <this repo> upstream && cd upstream
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
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `ADMIN_TOKEN`, `INGEST_TOKEN` | any long random strings, e.g. `node -e "console.log(crypto.randomUUID())"` |
| `GITHUB_TOKEN` | optional but recommended: anonymous GitHub API access is 60 requests/hour, which FUNDING.yml lookups exhaust quickly. A fine-grained token with public read access is enough |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → OAuth Apps; callback `PUBLIC_BASE_URL/api/claims/github/callback` |
| `PUBLIC_BASE_URL` | your https URL. PayPal only delivers webhooks to https, so use Render or a tunnel such as `cloudflared tunnel --url http://localhost:8787` |

For development, `npm run dev` runs the API with `--watch` and Vite on http://localhost:5173.

Connect Claude Code in the project you're working on:

```bash
node hook/install.mjs --url <PUBLIC_BASE_URL> --token <INGEST_TOKEN> --project /path/to/your/project --with-mcp
```

### Testing instructions for judges

1. **Sandbox accounts.** In the PayPal Developer Dashboard you have a sandbox *business* account (sends payouts) and can create a *personal* account (receives them, and also pays the subscription). Use the personal account's email when claiming.
2. **Fund.** Funding page → *Approve with PayPal* → log in with the sandbox personal account. Back on the page, *Sync from PayPal* books the first payment once PayPal reports it (the ledger shows gross and fee).
3. **Code.** Install the hook in any npm or Python project and run a short Claude Code session (for example "add input validation with zod"). The session appears under **Agent sessions** in real time.
4. **Attribute.** On the session page, first label packages under *Your ground truth* (labels saved before attribution count as blind), then *Attribute with Claude*. Compare the Claude and Baseline tabs and read the validator flags.
5. **Claim.** Open `/claim` and claim a GitHub repo **you** administer (for example one of your own packages the agent used), entering the sandbox personal email.
6. **Pay.** Payouts → *Plan payout* → review the policy checks → *Approve* → *Send with PayPal Payouts* → *Sync from PayPal*. Try *Replay batch* to see PayPal reject the duplicate `sender_batch_id`, and *Cancel* on an `UNCLAIMED` item (send to an email that has no sandbox account to produce one).
7. **Reconcile.** The Ledger shows every PayPal-confirmed movement and the API audit log (request ids, debug ids).

## Deploy on Render

`render.yaml` defines one web service with a 1 GB persistent disk for SQLite (this needs a paid instance; the free plan has no disk). It generates `ADMIN_TOKEN` and `INGEST_TOKEN` and prompts for secrets. After the first deploy, set `PUBLIC_BASE_URL` to the service URL and run `npm run doctor` and then `npm run setup:paypal` from the Render shell to register the webhook. The server also reconciles open batches hourly by itself.

## Tests

```bash
npm test          # parsers, evidence extraction, validator, money math, the hook script itself, and an end-to-end settlement
npm run doctor    # live, read-only checks against PayPal, Claude, GitHub, deps.dev and ecosyste.ms (needs .env)
npm run typecheck
```

The settlement test drives plan → approve → execute twice (exactly one PayPal POST) → replay (rejected) → UNCLAIMED → cancel → returned and re-held, against an in-process stand-in for PayPal's HTTP API. That stand-in exists only in the test file; the product always talks to PayPal.

## Tools used

| Tool | How it's used |
|---|---|
| **Claude** (`claude-opus-5-5` via the Anthropic TypeScript SDK) | Runtime: evidence-based value attribution with structured output, server-side refusal fallback. |
| **Claude Code hooks** | Runtime: the evidence collector (`PostToolUse`, `SessionStart`, `Stop`, `SessionEnd`). |
| **Model Context Protocol** (`@modelcontextprotocol/sdk`) | Runtime: Upstream's MCP server exposing guarded Payouts actions to agents. |
| **PayPal REST APIs** (sandbox) | Subscriptions, Payouts, Webhooks, as listed above. |
| **deps.dev API v3**, **ecosyste.ms Packages API**, **GitHub REST API** | Package → repo, funding links, FUNDING.yml, repo permissions. |
| **AG Grid Community** + **AG Charts Community** | Sessions, packages, payout items, allocations, ledger and API-audit grids; attribution and eval charts. |
| **Render** | Hosting via `render.yaml`. |
| Lucide, Simple Icons, Inter, JetBrains Mono | UI icons and type. |
| Claude Code (as a coding assistant) | Used to help write this project. |

## Limitations (on purpose, in the open)

- **Regulation.** Collecting money and redistributing it resembles a marketplace or money-transmission flow. Live Payouts needs PayPal to enable it on the account, and production would need PayPal's platform review. This project is sandbox-only.
- **Ecosystems.** npm and PyPI only. Claims are GitHub-only.
- **Evidence limits.** Code the agent writes from memory, without installing, importing, reading source or docs, leaves no trace. Unlabelled sessions have no accuracy guarantee; that's why the eval exists.
- **Partial refunds** of a subscription payment are flagged but not booked, because the transaction list doesn't break out the refunded amount.
- **Per-package cap.** In a session where one package did everything, the cap deliberately leaves the rest of that session's slice in the pool.

## What changed after the design review

An earlier review scored the idea 18.5/25 and listed weaknesses. Each claim was re-checked against primary sources:

| Review point | Check | What we did |
|---|---|---|
| Lead with 47%, not 60% | Confirmed (The Register; Tidelift's split is 60% "hobbyists" / 47% "unpaid for their work") | The pitch states both, with the distinction. |
| MCP-tool-only evidence is weak; Context7 already fills that slot; diff scans resemble thanks.dev | Agreed | The evidence comes from **hooks**, not tool choice. Context7 calls become evidence. API use and source reads go beyond manifest scanning. |
| "Used vs merely present" is the crux | Agreed | Explicit candidate status. The validator can never pay a merely-present package. |
| Claims need ownership proof (deps.dev links unverified) | Confirmed in deps.dev docs | GitHub admin/maintain check, or a FUNDING.yml token. Unverified repos are held, never paid. |
| Show the LLM beats a deterministic baseline | Agreed | Baseline plus eval on user-labelled sessions, like for like. |
| Rollover needs the cancel call | Confirmed (`POST /v1/payments/payouts-item/{id}/cancel`, UNCLAIMED only) | Policy auto-cancel plus a manual cancel button, books the return and re-holds. |
| "Funding in = payouts out + held" won't balance; fees | Confirmed (payout fee reported per item) | Fees are ledger lines from PayPal's own numbers. The reconciliation equation includes them. |
| Remote MCP is `/sse` and `/http`, not `/mcp` | PayPal's docs show `https://mcp.sandbox.paypal.com/sse` | Not used at runtime. Upstream calls the REST APIs directly. |
| An item-level DENIED webhook exists | **Not confirmed.** PayPal's event list has `PAYMENT.PAYOUTSBATCH.DENIED` only. | We subscribe to the 11 documented payout events. |
| AG Grid prize requires AG Studio | **Not confirmed.** The official rules say "submissions that use any AG Grid tools". | We use AG Grid and AG Charts where they do real work. A project can win only one sponsor prize anyway. |
| Deadline | Confirmed in the official rules: Nov 12, 2026, 12:00 pm PT | — |

## Sources

PayPal: [Payouts API](https://developer.paypal.com/docs/api/payments.payouts-batch/v1/) and [schema](https://developer.paypal.com/api/payments.payouts-batch/v1/schema.json) · [Cancel unclaimed payouts](https://developer.paypal.com/payouts/use-payouts/cancel-reverse-payouts) · [Webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/) · [Verify webhook signature](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post) · [Subscriptions API](https://developer.paypal.com/docs/api/subscriptions/v1/) · [Payouts fees](https://developer.paypal.com/payouts/fees) · [Agent Toolkit](https://github.com/paypal/agent-toolkit) · [MCP server](https://developer.paypal.com/tools/mcp-server/)
Data: [deps.dev API v3](https://docs.deps.dev/api/v3/) · [ecosyste.ms](https://ecosyste.ms/api) · [GitHub FUNDING.yml](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository) · [GitHub repos API](https://docs.github.com/en/rest/repos/repos)
Agents: [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Context7](https://github.com/upstash/context7) · [ATTRIBUTION.md](https://github.com/attributionmd/attribution.md) · [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
Context: [Tidelift 2024 (The Register)](https://www.theregister.com/2024/09/18/open_source_maintainers_underpaid/) · [Read the Docs on AI crawlers](https://about.readthedocs.com/blog/2024/07/ai-crawlers-abuse/) · [StackAid (2022)](https://itsfoss.com/news/stackaid-beta/) · [thanks.dev](https://thanks.dev) · [ecosyste.ms Funds](https://funds.ecosyste.ms)

## License

[MIT](LICENSE)
