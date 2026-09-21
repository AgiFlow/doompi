---
name: doompi-use-mcp
description: Use Doom Pi MCP to inspect domain-scoped servers, authenticate, reload configuration, measure what server tool schemas cost in context, and troubleshoot tool availability.
---

# Use Doom Pi MCP

Use MCP when a task depends on a configured external server, proxy upstream, or tool selected by the active Doom Pi domains.

## Remote MCP connection

This connection already belongs to one DoomPi session. Use the tools actually
exposed by its selected domains. Prefer a named upstream tool with its declared
schema. Use `mcp_use` only when the server name, tool name, and arguments have
been discovered from a trusted catalog; never guess them.

The commands below are local DoomPi interfaces, not Bash commands or MCP tools.
If status, authentication, or reload is not exposed, explain which local action
the user needs to take. Do not read private credentials or create another session
to work around an unavailable capability. Tool/resource support in a packaged
ChatGPT plugin does not establish support in this MCP connection.

## Local DoomPi: inspect and operate

- Run `/mcp` for the interactive overlay.
- Run `/mcp status` to inspect configured servers, connection state, and diagnostics.
- Run `/mcp auth <server>` when a server requires OAuth authorization.
- Run `/mcp reload` after changing MCP configuration.

Interactive status and browser-assisted authentication require a TUI. In a headless session, open a reported authorization URL manually.

## Measure and reduce what servers cost

In the local Pi runtime, connected servers contribute tool schemas to the model context, so a server that is irrelevant to the task still competes for context and still offers the model tools it could pick by mistake.

- Run `doompi --explain` to see the per-server token cost. Figures are measured from a real handshake and cached, so the first run for a new server descriptor is slower than later ones.
- Compare selections with `doompi --domains <name[,name...]> --explain` to see what a narrower domain actually saves.
- Reduce the cost by giving domains an `mcp.servers` allowlist in `.doom/domains.yaml` rather than by deleting servers from `.mcp.json`, which keeps them available to other domains.

Filtering activates only when every selected domain declares `mcp`. A selection that mixes an allowlisted domain with one that omits `mcp` stays unfiltered, which is the usual reason an expected saving does not appear.

## Troubleshoot missing tools

1. Confirm the server exists in repository `.mcp.json`, a valid Agent Plugin `mcp.json`, or `mcp-config.yaml` for proxy upstreams.
2. Confirm the active `.doom/domains.yaml` selection permits the direct server or proxy upstream.
3. Check `/mcp status` diagnostics before changing configuration.
4. Reload after a valid change, then confirm the tool catalog again.
5. If Doom Pi was launched with `--no-mcp`, keep MCP disabled unless the user explicitly starts a new session without that flag.

Domain filtering happens before disallowed stdio processes are spawned. Treat allowed stdio configuration as executable code because it runs with the Pi process environment and operating-system privileges. Keep OAuth stores and emitted configuration private.
