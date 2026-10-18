---
name: fund
description: Ask the user to top up the Upstream open-source pool with a one-time PayPal payment. Use only when the user explicitly asks to add money to the pool.
argument-hint: "[amount]"
# Money: only the user can start this, never the model on its own.
disable-model-invocation: true
---

The user asked to add money to the Upstream pool. Amount: $ARGUMENTS

1. If no amount was given, ask the user for one. Never pick an amount yourself.
2. Call the `upstream_request_funding` tool with that amount and, if the user gave one, a short reason.
3. Show the user the `approve_url` it returns and explain that nothing is charged unless they approve it on PayPal's own page.
4. If the tool refuses (agent top-ups off, or over the 24-hour limit), pass its message on as-is. Don't retry with a different amount.
