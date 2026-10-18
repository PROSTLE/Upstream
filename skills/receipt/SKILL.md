---
name: receipt
description: Show which open-source packages this coding session relied on and how Upstream would split its share between them. Use when the user asks what the agent used, for a usage receipt, or who would get paid.
---

1. Call the `upstream_session_evidence` tool from the `upstream` MCP server.
2. Summarise for the user, in a short list:
   - packages with status `used` and their evidence counts (installs, imports, API use, source read, docs);
   - packages that were only consulted (docs);
   - packages that were merely present in the manifest. Say plainly that these are never paid.
3. If `active_attribution` is present, show each package's share as a percentage. If it is null, say the session hasn't been attributed yet.
4. Report only what the tool returned. Don't estimate amounts or add packages it didn't list.
