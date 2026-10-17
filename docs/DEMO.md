# 3-minute demo script

Record against the PayPal sandbox with a real Claude Code session. Every number on screen must come from that run; nothing is pre-seeded. Lines in quotes are the narration; anything that describes a result must match what the recording shows, so adjust it to the run rather than the run to the script.

**Before recording:** subscription active and its first payment synced; you have claimed one real repo you administer (sandbox personal email); the hook is installed in a small project that uses that package.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Overview | "Almost half of open-source maintainers say they're unpaid for their work. Our AI agents lean on their code all day. Upstream pays them, based on what the agent actually used." |
| 0:15–0:35 | Funding → *Approve with PayPal* (already done; show ACTIVE and the ledger line) | "I approve a fixed monthly agent tithe once, with PayPal Subscriptions. Only money PayPal confirms ever enters the pool, fees included." |
| 0:35–1:05 | Claude Code terminal | Ask the agent for a small feature that uses your package and one other library. "Hooks record every install, import, API call and doc read. The agent doesn't have to cooperate." |
| 1:05–1:40 | Session page → *Attribute with Claude* | "Claude weighs the evidence and must cite it. Code then drops anything uncited, hallucinated, or merely present in the manifest." Point at a package from this run that was only in the manifest and show its 0 weight. Open the Baseline tab and narrate the real difference you see. Then show the Eval page with its actual scores, even where the baseline wins. |
| 1:40–2:20 | Payouts → *Plan* → policy checks → *Approve* → *Send with PayPal Payouts* → *Sync* | "One PayPal Payouts batch. Verified maintainers only; unclaimed repos are held. Item statuses come back over signature-verified webhooks." Click *Replay batch*: "Same batch again, and PayPal rejects the duplicate sender_batch_id. No double pay." |
| 2:20–2:45 | Claim page, then the Ledger | "Maintainers prove they control the repo with GitHub or a FUNDING.yml token. Every ledger line comes from PayPal's own numbers, fees included." Show the ledger next to the sandbox dashboard. Only say "to the cent" if the two actually match in this run. |
| 2:45–3:00 | Connect page (MCP) | "PayPal's Agent Toolkit has no Payouts tool. Ours lets agents pay humans, but only batches a human approved. Every agent session can fund its upstream." |
