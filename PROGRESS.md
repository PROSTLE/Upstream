# Upstream: progress report

**Project:** Upstream, an entry for *Build What's Next with PayPal and AI* (Devpost)
**Deadline:** Thu **Nov 12, 2026, 12:00 pm PT** (= Nov 13, 1:30 am IST), from the official rules
**Status date:** Oct 11, 2026 (second pass the same day; see section 5a)

**Short version:** the product is built, tested offline, and documented. Nothing has run against the live PayPal sandbox or Claude yet, because this machine has no credentials. That first real run is the most important step left.

---

## 1. What Upstream is

The idea: an AI coding agent's real usage of open-source packages decides which maintainers get paid, through PayPal.

1. A **Claude Code hook** records what the agent actually did: installed, imported and used, studied a library's source, read docs.
2. **Claude** turns that evidence into weights and must cite evidence for each one.
3. **Code** (not the model) validates: no hallucinated packages, no uncited weights, nothing that is "merely present" in the manifest, and a per-package cap.
4. Maintainers **prove they control the repo** (GitHub admin/maintain, or a FUNDING.yml token).
5. A human approves, and Upstream sends **one PayPal Payouts batch**. It's funded by a **PayPal Subscription** (the "agent tithe") and reconciled from PayPal's own numbers.

---

## 2. Research and verification done

Every claim the build relies on was checked against a primary source (PayPal's published OpenAPI schemas, official docs, the Devpost rules page).

### Confirmed

| Fact | Source |
|---|---|
| Deadline Nov 12, 12:00 pm PT; judging Dec 1–15; winners about Dec 21 | Devpost official rules |
| A project can win at most 1 grand or honorable-mention prize + 1 sponsor prize | Devpost official rules |
| Repo must be public with a visible license; video under 3 minutes on YouTube; judges may score from video and text alone | Devpost official rules |
| Project must stay available free until judging ends | Devpost official rules |
| Payouts: `sender_batch_id` reuse within 30 days is rejected; 5xx retries with the same id are safe; max 15,000 items; `page_size` max 1000 | PayPal Payouts `schema.json` |
| Payout item statuses: SUCCESS, FAILED, PENDING, UNCLAIMED, RETURNED, ONHOLD, BLOCKED, REFUNDED, REVERSED | PayPal Payouts `schema.json` |
| Cancel endpoint `POST /v1/payments/payouts-item/{id}/cancel`, UNCLAIMED items only; unclaimed payouts otherwise return after 30 days | PayPal "Cancel or reverse payouts" doc |
| Payout fee is reported per item (`payout_item_fee`); typical rate about 2% | PayPal schema and fees page |
| Webhook verify body fields and `PAYPAL-*` header names; response `SUCCESS`/`FAILURE` | PayPal webhooks `schema.json` |
| Subscriptions fields (plan, billing cycle, `total_cycles: 0` = until cancelled, transactions list with gross/fee/net) | PayPal Subscriptions `schema.json` |
| PayPal Agent Toolkit has **no Payouts tool** | `paypal/agent-toolkit` README |
| Remote PayPal MCP is `mcp.sandbox.paypal.com/sse` | PayPal MCP docs |
| Claude Code `PostToolUse` input (`tool_name`, `tool_input`, `tool_response`, `transcript_path`), `async` hooks, SessionEnd 1.5 s default budget | code.claude.com hooks docs |
| deps.dev API v3 endpoints; repo links "are not verified for correctness" | docs.deps.dev |
| GitHub `GET /repos/{o}/{r}` returns `permissions.admin/maintain` | GitHub REST docs |
| Context7 tools: `resolve-library-id(libraryName, query)`, `query-docs(libraryId, query)` | upstash/context7 README |
| ATTRIBUTION.md exists (v0.1 draft, stars only, no money) | attribution.md, GitHub |
| Render Blueprint `disk` = `name`, `mountPath`, `sizeGB` | Render's official `render.yaml.json` schema |

### Corrections to the two earlier AI reports

| Claim | Verdict |
|---|---|
| "60% of maintainers are unpaid" | Imprecise. **60% call themselves unpaid hobbyists; 47% say they're unpaid for their work** (The Register on Tidelift 2024). The pitch uses both, with the distinction. |
| There is an item-level `PAYOUTS-ITEM.DENIED` webhook | **False.** Only `PAYMENT.PAYOUTSBATCH.DENIED` exists. |
| AG Grid prize requires AG Studio | **Not supported.** The official rules say "any AG Grid tools". |
| Remote MCP path is `/mcp` | **Wrong** per PayPal's docs (`/sse`, and `/http`). Not used at runtime anyway. |
| 2:00 pm PT deadline (third-party listing) | **Wrong.** It's 12:00 pm PT. |
| $67,500 vs $69,750 prize total | The gap is the Render credit prizes ($1,000 + $750 + $500). |

### Still unverified (treated cautiously in code)

- `PAYMENT.SALE.COMPLETED` → `resource.billing_agreement_id` links a sale to its subscription. Only third-party samples show it. **Handled:** if it's missing or unknown, every known subscription is synced instead.
- Exact USD payout fee caps (third-party figures only). **Handled:** fees are never assumed; they're read from PayPal per item.
- thanks.dev 5% commission, StackAid's $14,934 counter, SourceHut's 168-hour downtime. Not used in the pitch.

---

## 3. What was built

```
c:\Lang\paypal
├─ server/        Node 24 + TypeScript (no build step), Express 5, built-in SQLite
├─ web/           React 19 + Vite, AG Grid + AG Charts, Lucide + Simple Icons, light theme
├─ hook/          Claude Code hook (evidence collector) + installer
├─ mcp/           MCP server: guarded Payouts tools for agents
├─ docs/DEMO.md   3-minute video script
├─ README.md      submission-grade docs (requirements map, Tools used, setup, limitations, sources)
├─ render.yaml    Render Blueprint (web service + persistent disk)
├─ .env.example   every setting documented; nothing hardcoded
└─ LICENSE        MIT
```

### Server (`server/src`)

| Area | Files | What it does |
|---|---|---|
| Config | `config.ts` | Validates every env var with Zod; missing credentials disable a feature (never a mock fallback) |
| Storage | `db.ts`, `ledger.ts`, `money.ts` | SQLite schema; idempotent ledger (dedupe keys); money in integer minor units using `Intl` currency digits; exact largest-remainder splits |
| PayPal client | `paypal/client.ts` | OAuth2 token cache, `PayPal-Request-Id`, `PayPal-Debug-Id` capture, audit log of every call |
| Funding | `paypal/subscriptions.ts`, `funding.ts` | Product + plan setup, subscription with approve link, transaction-list sync (gross + fee) as the single source of truth |
| Payouts | `paypal/payouts.ts`, `settlement.ts` | Plan → policy checks → human approve → send (frozen request, fixed `sender_batch_id`) → sync → cancel UNCLAIMED → returns re-held; replay to show PayPal's duplicate rejection; recovery if an earlier send landed |
| Webhooks | `paypal/webhooks.ts`, `paypal/events.ts` | Registers or patches the webhook, verifies signatures with the raw body spliced in byte-for-byte, processes idempotently, retries via non-2xx |
| Evidence | `evidence/parse.ts`, `extract.ts`, `ingest.ts`, `candidates.ts` | Parses installs (npm/pnpm/yarn/bun/pip/uv/poetry/pdm), JS/TS/Python imports + lines using them, API use on existing imports, library source reads, docs URLs, Context7 lookups, manifest diffs; Python import→distribution map; used / consulted / merely-present |
| Resolution | `resolve/index.ts` | deps.dev + ecosyste.ms + GitHub FUNDING.yml, with provenance (attested vs unverified) and conflict flags, cached |
| AI | `attribution/llm.ts`, `validate.ts`, `baseline.ts`, `run.ts`, `eval.ts` | Claude structured output with citations; validator rules; import-count baseline; divergence flags; eval (precision / recall / F1 / accuracy / L1) on human labels |
| Claims | `claims.ts` | GitHub OAuth + admin/maintain check, or FUNDING.yml token; one payable claim per repo; public token can't change the payout email |
| API + jobs | `index.ts`, `scripts/setup-paypal.ts` | REST API, admin-token guard, ingest-token guard, hourly reconciler + unclaimed auto-cancel, serves the built UI |

### Hook (`hook/`)
- `upstream-hook.mjs`: never blocks the agent (async, always exits 0). Redacts secret files, sends only the path for reads of your own files, attaches the file head for import context, snapshots manifests at start and stop, and spools offline.
- `install.mjs`: merges hooks into `.claude/settings.json` (project or user scope) and optionally registers the MCP server.

### MCP server (`mcp/`)
Five tools: `upstream_session_evidence`, `upstream_attribute_session`, `upstream_plan_payout`, `upstream_send_approved_payout`, `upstream_payout_status`. The model can never choose receivers or amounts, and can only send a batch a human approved.

### Web UI (`web/`)
Pages: Overview (stats, money-flow diagram, checklist, PayPal activity) · Funding · Agent sessions · Session detail (evidence timeline, candidates, Claude-vs-baseline tabs + chart, validator flags, raw hook payload viewer, ground-truth labels) · Packages & maintainers · Payouts (policy checks, approve/send/sync/replay/cancel, request JSON) · Ledger (flow, donut, entries, PayPal API audit) · Attribution eval · Connect your agent · public Claim, Claim complete and `/c/:token` pages.

---

## 4. Fixes for the loopholes the review raised

| Loophole | Fix in the code |
|---|---|
| Evidence depended on the agent choosing Upstream's MCP tools | Evidence comes from **hooks** on every tool call. Context7 calls are captured too. |
| Diff import scan ≈ thanks.dev static analysis | Adds API use on existing imports, library source reads (reimplementation), docs, CLI runs, and an in-session manifest diff |
| Can't separate "used" from "merely present" | Explicit candidate status. The validator zeroes any weight not backed by linked evidence. |
| Claims had no ownership proof | GitHub admin/maintain permission check, or FUNDING.yml token on the default branch |
| AI might be "bolted on" | Baseline + eval on human-labelled sessions, compared like for like |
| Unclaimed rollover lacked the cancel call | Auto-cancel after a policy period + manual cancel; return booked, money re-held for the repo |
| Ledger wouldn't balance (fees) | Funding and payout fees are ledger lines from PayPal's reported amounts; the fee reserve shrinks as real fees arrive |
| Staged-claimant risk in the demo | Demo plan: claim a repo **you actually administer**; unclaimed repos are visibly held, never paid to fake people |

---

## 5. Testing done

| Check | Result |
|---|---|
| Unit and integration tests (`npm test`) | **18/18 pass**: the real hook script (Python import map, `json.py` shadowing, Stop resend rule), parsers, evidence extraction, ingest → candidates pipeline, webhook raw-body verification, validator, baseline, money math, end-to-end settlement (execute twice = 1 POST, replay rejected, UNCLAIMED → cancel → returned → re-held) |
| Typecheck (server, web, mcp) | Clean |
| Production build | Clean; pages code-split (main chunk about 288 KB; AG Grid/Charts load only on data pages) |
| Smoke run | Real server + real hook script + live deps.dev / ecosyste.ms / GitHub. Events were **simulated**: Claude Code-shaped payloads piped through the hook, not a real Claude Code session. Evidence, candidates, docs linking, redaction (`.env` never stored), admin guard and baseline all worked. |
| UI | Desktop screenshots reviewed and polished; responsive fixes verified at 520 px. Exact 390 px couldn't be verified (headless Edge enforces about a 500 px minimum). |
| MCP server | Responds to `initialize` and `tools/list` over stdio |

**The PayPal stand-in exists only in `server/test/settlement.test.ts`.** The product never mocks PayPal.

### 5a. Second pass (Oct 11): what was found and fixed

| Finding | Evidence | Fix |
|---|---|---|
| **Python import mapping never worked on this machine.** `packages_distributions()` takes about 4.1 s here (367 distributions; bare Python startup is 84 ms). The hook's limit was 4.0 s, so it always timed out and sent no map. `import yaml`, `PIL` or `bs4` would have been "unattributed" unless the name was in the manifest. | 3 timed runs: 4093, 4076 and 4208 ms; the hook function returned nothing after 4140 ms | The map is cached per interpreter in `~/.upstream/py-import-map/`, keyed by the mtimes of the `sys.path` directories (about 0.3 s per hook run on a cache hit). SessionStart gets 8 s (its hook budget is 10 s). |
| Packages installed mid-session were never mapped (the map was only built at SessionStart) | Real test: venv, then `pip install python-dateutil` during the session | `Stop` (async) recomputes and resends only when the environment fingerprint changed. Verified: the first Stop sent `dateutil → python-dateutil` and `six`; the second Stop sent nothing. |
| **Security:** `python -c` puts the cwd first on `sys.path`, so a project file named `json.py` ran inside the hook | Demonstrated: `python -c "import json"` beside a planted `json.py` created its marker file | The cwd is removed from `sys.path` before anything is imported. Covered by `server/test/hook.test.ts`. |
| Credentials were only reported as "set / not set" | n/a | New `npm run doctor`: live, read-only checks (PayPal OAuth + `GET /v1/billing/plans`, Claude `models.retrieve` for `UPSTREAM_MODEL`, GitHub rate limit, deps.dev, ecosyste.ms, public URL `/api/health`). It writes nothing and sends no prompt. `GET /v1/billing/plans` re-checked on developer.paypal.com ("Lists billing plans"). |
| Anonymous GitHub API had **1 of 60** requests left this hour on this machine | doctor output | Doctor warns when `GITHUB_TOKEN` is unset; README now recommends one. |
| Claude call shape | Checked against the current Claude API reference: `client.beta.messages.parse` + `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"` + `output_config.effort`/`format` is the documented form for `claude-opus-5-5` | No change needed. Still not run live (no key). |

---

## 6. What's left

### A. You need to do these (I can't without your accounts)

| # | Task | How | Est. |
|---|---|---|---|
| 1 | PayPal sandbox app | developer.paypal.com → Apps & Credentials → Sandbox → create app → `PAYPAL_CLIENT_ID/SECRET` in `.env` | 10 min |
| 2 | Sandbox personal account | Developer Dashboard → Sandbox accounts → create **Personal** (pays the subscription, receives a payout) | 5 min |
| 3 | Anthropic API key | console.anthropic.com → `ANTHROPIC_API_KEY` | 5 min |
| 4 | GitHub OAuth app | GitHub → Settings → Developer settings → OAuth Apps; callback `PUBLIC_BASE_URL/api/claims/github/callback` | 5 min |
| 5 | Public https URL | Render (`render.yaml`, paid instance for the disk) **or** `cloudflared tunnel --url http://localhost:8787` for local | 15–30 min |
| 6 | Create `.env` | `cp .env.example .env`; generate `ADMIN_TOKEN` and `INGEST_TOKEN` (32+ random characters) | 5 min |
| 6b | GitHub token (recommended) | Fine-grained personal access token with public read access → `GITHUB_TOKEN`. Anonymous access is 60 requests/hour. | 3 min |
| 7 | Check + PayPal setup | `npm run doctor` (should show no FAIL), then `npm run build && npm run setup:paypal && npm start` | 5 min |

### B. First real end-to-end run (highest priority, as soon as A is done)

- [ ] Approve the subscription in the sandbox → *Sync from PayPal* → confirm gross and fee in the ledger
- [ ] Install the hook in a real project → do a **real** Claude Code session → confirm events arrive
- [ ] *Attribute with Claude*: first live call. Watch for a schema or `fallbacks` error from `client.beta.messages.parse` (typechecked but never called live)
- [ ] Claim a repo you administer (GitHub OAuth) with the sandbox personal email
- [ ] Plan → Approve → Send → confirm webhooks arrive **verified** → Sync → Replay (expect rejection) → Cancel an UNCLAIMED item (send one to an email with no sandbox account)
- [ ] Confirm the ledger balances against what the PayPal sandbox dashboard shows
- [ ] Note any field mismatch (e.g. `billing_agreement_id`, cancel response status) and fix

### C. Evidence that makes the pitch credible

- [ ] Record **5–10 real sessions** across npm and Python projects
- [ ] Label them on each session page → read the **Eval page**. Report whatever it shows, including if the baseline wins somewhere; improve the prompt only against those results.
- [x] Confirm Python import mapping works on your machine. It **didn't** (timeout); fixed and verified with Python 3.13 and a project `.venv` (section 5a)

### D. Submission packaging

- [x] `git init` + first local commit (branch `main`)
- [ ] Create a **public** GitHub repo and push; check that MIT shows in the About section
- [ ] Replace `<this repo>` in the README with the real URL; add a hosted demo URL + testing instructions (read-only access, or share `ADMIN_TOKEN` privately with judges)
- [ ] Record the video (< 3 min) from `docs/DEMO.md` using **real** numbers only; upload to YouTube (public); no copyrighted music
- [ ] Write the Devpost text: problem, who it's for, how PayPal and Claude are used (copy from the README "Tools used" table)
- [ ] Pick **one** sponsor prize to aim for (AG Grid is the natural fit; Render is the other option)
- [ ] Keep the hosted demo up until **Dec 15** (end of judging)

### E. Known gaps (by design or not built)

| Gap | Note |
|---|---|
| Only npm + PyPI; GitHub-only claims | Cargo/Go/Maven and GitLab are out of scope for the deadline |
| Code the agent writes from memory leaves no trace | Inherent limit; stated in the README |
| Partial subscription refunds | Flagged, not booked (PayPal's transaction list doesn't break out the amount) |
| One funder per deployment | Multi-tenant is out of scope |
| Money-transmission / marketplace regulation | Sandbox only; stated openly; live Payouts needs PayPal enablement + review |
| AG Studio not used | Optional; the rules only require "any AG Grid tools" |
| Transcript backfill (importing past Claude Code JSONL sessions) | Not built; the transcript format is undocumented, so hooks are the supported path |

### Suggested timeline to Nov 12

| Window | Focus |
|---|---|
| Oct 11–15 | Section A + B: first live sandbox run, fix anything it reveals |
| Oct 16–25 | Section C: real sessions, labels, eval; prompt tuning against the eval only |
| Oct 26–Nov 2 | Deploy on Render, end-to-end on the hosted URL, polish |
| Nov 3–8 | Video, Devpost text, README links |
| Nov 9–11 | Buffer; submit **before Nov 12, 12:00 pm PT** |

---

## 7. Command reference

```bash
npm install                 # all workspaces
npm run dev                 # API (watch) + Vite on :5173
npm run build && npm start  # production on :8787
npm run doctor              # live, read-only credential and API checks
npm run setup:paypal        # sandbox product, plan, webhook (idempotent)
npm test                    # 18 tests
npm run typecheck           # server, web, mcp
node hook/install.mjs --url <PUBLIC_BASE_URL> --token <INGEST_TOKEN> --project <dir> --with-mcp
```
