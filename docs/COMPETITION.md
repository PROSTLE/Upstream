# Competition and novelty check (Oct 18, 2026)

> Nov 6 update: attribution now runs on Meta Muse Spark, not Claude. Where this document says Claude about Upstream's own attribution, read Muse Spark. Claude Code is still the agent being measured.

How Upstream compares with the other entries in *Build What's Next with PayPal and AI* and with existing open-source funding products. Sources: a GitHub search for public hackathon repos created after Sep 15, 2026 (287 repos; the Devpost gallery isn't public yet and returns 403), the repos' READMEs and code, and the products' own sites.

## 1. Where the field is

Most public entries cluster in five themes:

| Theme | Examples | Rough count in the 287 |
|---|---|---|
| Spending guardrails / mandates for AI agents | agenttab, leash, permit, countersign, allowagent-mcp, mandat, allowance | many (largest group) |
| AI-verified escrow (authorize → AI checks → capture/void) | stood, trustrail-hold, fairshake, PayGrade, ArbiterPay, handback | many |
| Invoicing and collections agents | paid-tonight, kindly, owed, chaser, docket, sorted | many |
| Shopping / checkout agents (MCP storefronts, WebMCP) | suede-shelf, paypal-webmcp-shop, agentcart, gofer | several |
| Disputes and risk | dispute-autopilot, rebuttal, exhibit, dispute-radar | several |

Open-source funding is almost empty. One entry is a direct competitor.

## 2. The direct competitor: `iamarunbrahma/upstream`

Same name, same pitch: *"Your AI coding agent pays back the open source it builds with."* Public since Oct 14, ~100 commits, Next.js + shadcn/ui, hosted sandbox demo, records of live sandbox runs.

| | Theirs | Ours |
|---|---|---|
| Evidence | **Counts only**, built at `SessionEnd` from the transcript: installed, manifest added, import files, usage lines, docs reads | **Per tool call** via `PostToolUse`: installs, imports + lines using them, API use on existing imports, library **source reads** (reimplementation), docs URLs, Context7 lookups, manifest diff; each record citable |
| AI | Gemini 2.5 Flash-Lite judge, heuristic fallback, cap of 2× the evidence share | Claude with structured output that **must cite evidence ids**; code drops uncited/hallucinated/merely-present weights |
| Eval | Kendall tau on recorded fixture sessions | Precision/recall/F1/L1 vs a baseline on **your own labelled sessions**, with a **blind** subset |
| Who gets paid | FUNDING.yml GitHub users or **recent committers**, once they sign in with GitHub + Log in with PayPal | Only a maintainer who proves **admin/maintain** access or commits a FUNDING.yml token |
| Unclaimed money | Waits for the maintainer | Held, auto-cancel of `UNCLAIMED` payouts, returned and re-held, released to the pool after N days |
| PayPal surface | Subscriptions, Orders v2 (one-time top-up, also from the agent via Agent Toolkit), JS SDK v6, Payouts, Webhooks, **Log in with PayPal** | Subscriptions, Payouts (create/show/item/cancel), Webhooks with raw-body verification, idempotent replay proof |
| Product polish | Hosted "Try the demo" with per-visitor accounts, npm CLI `upstream-pay`, Claude Code plugin with `/upstream:receipt` and `/upstream:fund` | Local run; hook installer + MCP server; no hosted URL yet |
| Live proof | Live sandbox runs recorded in `docs/` | **None yet** (no credentials on this machine) |

Read honestly: we are deeper on the evidence, the AI checks and the money safety; they are ahead on demo-ability, PayPal breadth and having run live.

## 3. Existing products (outside the hackathon)

| Product | Splits money by | Gap Upstream fills |
|---|---|---|
| thanks.dev, ecosyste.ms Funds, StackAid (2022) | Dependency manifests / code scans | Can't tell a library the agent leaned on all afternoon from one nobody touched |
| Open Source Pledge, GitHub Sponsors, Open Collective | The company's or person's own choice | No usage signal at all |
| ATTRIBUTION.md v0.1 | Asks agents to credit (stars only) | No money |
| Anthropic's Claude for Open Source | Free Claude Max for maintainers | Perk, not payment |

No product or program was found that pays maintainers from evidence of **runtime agent usage**. That claim still holds, with the caveat that one other hackathon entry now makes it too.

## 4. Ratings (out of 10)

Before this pass → after this pass (Oct 18).

| Parameter | Before | After | Why |
|---|---|---|---|
| Novelty vs the whole field | 8 | 8 | Nearly empty niche among 287 entries |
| Novelty vs the direct competitor | 5 | 6 | Same core idea; our evidence depth, citations and blind eval are real differentiators, and the money trail + README badge are things they don't have |
| Technical implementation | 8.5 | 9 | Idempotency, reconciliation, validator, tests (24/24) |
| Meaningful AI | 7 | 7 | Strong design, but Claude has **never been called live** |
| Meaningful PayPal | 7 | 8 | 5th pass added Orders v2 top-ups and Log in with PayPal, so breadth now matches the competitor; still not run live |
| Design / UX | 6 | 8.5 | Redesign: guided next step, money-flow nav, dark mode, palette, confirm-before-money, receipts, trail, claim stepper |
| Potential impact | 7 | 7.5 | Maintainer growth loop (public repo page + badge + invite links) |
| Demo-ability for judges | 3 | 3.5 | Still no hosted URL, no credentials, no live run: the biggest risk |
| Presentation | 4 | 4 | No video, repo not public yet |
| Trust & safety | 9 | 9 | Ownership proof, held money, cancel/return, never pays unverified |

Judging is five equally weighted criteria (Technological Implementation, Design, Potential Impact, Innovation, Presentation). Design moved most this pass; Presentation and demo-ability are now the weakest and decide the result.

## 5. What can be added (and what was done)

Done in this pass:

1. Public **repo page** `/r/:owner/:name`: what agents relied on, held / in flight / paid, claim status, claim button.
2. **README badge** `/api/badge/:owner/:name.svg` ("$X waiting · claim it", "$Y paid by agents"), linking to the repo page: a growth loop that brings maintainers to claim.
3. **Money trail**: for any repo, every allocation → sessions → validated weight, Claude's rationale and the cited evidence → PayPal payout items. Opens from Packages and from every payout row.
4. **Session receipt** in plain language, with **Copy credits for your PR** (Markdown table of packages, roles, shares and reasons).
5. **Invite** button on unclaimed repos (copies a prefilled claim link) and a "money waiting for maintainers" list on the claim page.
6. **Confirm-before-money** dialogs that name the amount and receivers (approve, send, cancel, discard).
7. **Live updates**: sessions and the overview refresh while the tab is visible; an open session streams new evidence.
8. **Guided setup**: one "next step" card with the exact action or command, numbered money-flow navigation with done states.
9. **Command palette** (Ctrl/⌘ K or `/`), **dark mode** (system / light / dark), mobile navigation drawer, skeleton loading, accessible focus, WCAG 2.2 target sizes.
10. Fixed a pre-existing bug: the Claude-vs-baseline chart on the session page drew "No data" (horizontal bar axes).

Next, in priority order (not done; most need credentials or a decision):

1. **Live sandbox run end to end** (PROGRESS §6B). Without it, "meaningful AI" and "meaningful PayPal" are claims, not demos.
2. **Hosted demo URL** (Render) with sandbox test accounts in the Devpost testing notes. The competitor has one.
3. **Rename or sharpen the name.** Two entries called "Upstream" with the same tagline invites a "duplicate" read by judges. `BRAND_NAME` already drives the UI, badge and public pages.
4. ~~Log in with PayPal for maintainers~~ **done (5th pass)**, verified email; untested live.
5. ~~Orders v2 one-time top-up + agent request tool~~ **done (5th pass)**, capped per 24 h; untested live.
6. ~~Claude Code plugin packaging~~ **done (5th pass)**: `/upstream-oss:receipt`, `:credits`, `:fund`.
7. Demo video (< 3 min) using only real numbers from the live run.

## 6. Re-check (Oct 21, 2026)

Sources: GitHub search API (repos created after Sep 15 mentioning PayPal, plus OSS-specific queries), each repo's README and `docs/`, and the GitHub API for dates and commit counts. The Devpost gallery still returns 403, so entries that never mention PayPal or open source on GitHub are invisible here. Nothing below was run; it is what the repos publish.

### Entries closest to ours

| Entry | What it does | PayPal | AI | Hosted demo / video | Live-run proof |
|---|---|---|---|---|---|
| **iamarunbrahma/upstream** (direct) | Same pitch; session-end receipts from counts; splits a monthly budget to FUNDING.yml people or recent committers | Subscriptions, Orders v2 via **PayPal Agent Toolkit**, JS SDK v6, Payouts, Webhooks, Log in with PayPal | Gemini 2.5 Flash-Lite judge + fallback | Yes (Render) | Yes: `docs/e2e-agent-payments.md` records real sandbox order ids, fees and a cancel path. 127 commits |
| Sahil-u07/mergepay | Bounties on GitHub issues, paid after merge if an AI review agrees | Payouts | Gemini (+ backup model) | Yes (Render) + 2 min 16 s video | Yes, per README and video |
| tempoloss/proofpay (Oct 20) | Escrowed issue bounties: authorize, then capture when CI is green and the AI quotes added lines | Orders v2 authorize/capture + Payouts | AI judge whose quotes code checks | Yes (own domain, also an MCP endpoint) | Not shown in the README excerpt read |
| VARUN3WARE/Linus | Month-end close for an OSS bounty pool; reproducible verdicts | Not confirmed from the README excerpt read | OpenAI + a second checker | Demo repo with 16 real PRs + video on X | Verdicts posted on real PRs |
| arjunkshah12345-hash/contextpay | A coding agent buys context compression within a mandate | Vault v3 + Orders v2 (merchant-initiated) | Claude planner | No | Not shown; has a **mock mode** (we have none, by design) |

### Benchmark: who is ahead, and where

| Criterion (Devpost, equal weight) | Ahead of us | Why |
|---|---|---|
| Technological implementation | Nobody clearly | Ours: per-tool-call evidence, citation-checked Claude output, idempotent batches + replay proof, unclaimed cancel/return, reconciliation, 37 tests. But theirs ran live; ours has not. |
| Design | Can't judge others without running them | Ours: guided setup, money trail, receipts, claim flow, dark mode |
| Potential impact | Level with iamarunbrahma/upstream | Same market; mergepay/proofpay serve bounties, a narrower job |
| Innovation | iamarunbrahma/upstream weakens ours | Same idea and name. Our first local commit is Oct 11 and their repo went public Oct 14, but ours isn't public yet, so judges will see theirs first. Our differentiators are evidence depth, citations and the blind eval |
| Presentation | **iamarunbrahma/upstream, mergepay, Linus, proofpay** | All have a hosted demo and/or video and recorded live runs; we have neither yet |

**Verdict:** on presentation and demo-ability, which judges see first, iamarunbrahma/upstream and mergepay are ahead of us today. On depth and money safety we are at least level, and ahead of the direct competitor on evidence and AI checks. The gap is closable only by a live run, a hosted URL and a video.

### Ratings (Oct 21, out of 10)

| Aspect | Score | Basis |
|---|---|---|
| Novelty vs the whole field | 8 | Still a near-empty niche; only one other entry pays maintainers from agent usage |
| Novelty vs the direct competitor | 6 | Same core idea and name; differentiators are real but subtle to a judge |
| Technical implementation | 8.5 | Audit this pass found and fixed 12 bugs (2 security, 1 Windows hook crash); 37/37 tests. Not 9 until it runs live |
| Meaningful use of AI | 6.5 | Strong design (cited evidence, validator, baseline, blind eval) but Claude has never been called live and the eval has no labelled sessions |
| Meaningful use of PayPal | 7.5 | Subscriptions, Orders v2, Payouts, Webhooks, Log in with PayPal; zero live calls |
| Design / UX | 8 | From code review this pass; no new screenshots taken |
| Potential impact | 7.5 | Growth loop (badge, repo page, invites) |
| Trust & safety | 9 | Claim take-back holes closed this pass |
| Demo-ability for judges | 3 | No hosted URL, no credentials |
| Presentation | 3.5 | No video; repo not public |
| **Devpost average** (Tech, Design, Impact, Innovation, Presentation) | **≈ 6.9** | (8.5 + 8 + 7.5 + 7 + 3.5) / 5, with Innovation taken as the mean of the two novelty scores |

### What would move the score most (unchanged order)

1. Live sandbox run with real Claude attribution (Tech, AI, PayPal all move up).
2. Hosted URL + sandbox test accounts in the Devpost testing notes.
3. Video under 3 minutes using only numbers from that run (Presentation 3.5 → 7+).
4. Rename, or lead the pitch with the differentiators (per-call evidence, cited weights, blind eval), so judges don't read it as a duplicate.
