---
name: statement
description: Issue a month's funding statement as a PayPal invoice marked paid. Use only when the user explicitly asks for a statement.
argument-hint: "[YYYY-MM]"
# It creates a document in the user's PayPal account: only the user can start this, never the model on its own.
disable-model-invocation: true
---

The user asked for a funding statement. Month: $ARGUMENTS

1. If no month was given, ask for one in the form YYYY-MM. Never pick a month yourself.
2. Call the `upstream_issue_statement` tool with that month.
3. Show the user the `view_url` it returns and the invoice's status. Explain that it moves no money and emails nobody: it records payments PayPal already confirmed.
4. If `payments_recorded_by_note_only` isn't empty, say that PayPal wouldn't link those transaction ids to the invoice, so each id is in that payment's note.
5. If the tool refuses, for example because no payment was confirmed that month, pass its message on as-is.
