---
name: doompi-use-mcp
description: Use Doom Pi MCP to inspect domain-scoped servers, authenticate, reload configuration, and troubleshoot tool availability.
---

# Use Doom Pi MCP

Use MCP when a task depends on a configured external server, proxy upstream, or tool selected by the active Doom Pi domains.

## Inspect and operate

- Run `/mcp` for the interactive overlay.
- Run `/mcp status` to inspect configured servers, connection state, and diagnostics.
- Run `/mcp auth <server>` when a server requires OAuth authorization.
- Run `/mcp reload` after changing MCP configuration.

Interactive status and browser-assisted authentication require a TUI. In a headless session, open a reported authorization URL manually.

## Troubleshoot missing tools

1. Confirm the server exists in repository `.mcp.json`, a valid Agent Plugin `mcp.json`, or `mcp-config.yaml` for proxy upstreams.
2. Confirm the active `.doom/domains.yaml` selection permits the direct server or proxy upstream.
3. Check `/mcp status` diagnostics before changing configuration.
4. Reload after a valid change, then confirm the tool catalog again.
5. If Doom Pi was launched with `--no-mcp`, keep MCP disabled unless the user explicitly starts a new session without that flag.

Domain filtering happens before disallowed stdio processes are spawned. Treat allowed stdio configuration as executable code because it runs with the Pi process environment and operating-system privileges. Keep OAuth stores and emitted configuration private.
