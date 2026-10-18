---
name: credits
description: Write an "Open-source credits" block for the current change, listing the open-source packages this session relied on, from Upstream's validated attribution. Use when the user asks for credits, attribution, or a PR description that credits dependencies.
---

1. Call the `upstream_session_credits` tool from the `upstream` MCP server (no arguments means the most recent session).
2. If it says the session has no attribution yet, tell the user to attribute the session in the Upstream dashboard (or call `upstream_attribute_session` if they ask you to), then try again.
3. Otherwise paste the Markdown it returns as-is into the PR description or wherever the user asked. Don't change the shares or reasons: they come from Upstream's validated attribution, not from you.
