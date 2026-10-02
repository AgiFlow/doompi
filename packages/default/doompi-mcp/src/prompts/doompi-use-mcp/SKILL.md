---
name: doompi-use-mcp
description: Use Doom Pi MCP to inspect domain-scoped servers, authenticate, reload configuration, measure what server tool schemas cost in context, and troubleshoot tool availability.
---

# Use Doom Pi MCP

Use MCP when a task depends on a configured external server, proxy upstream, or tool selected by the active Doom Pi domains.

## Named tools and accounts

Main and native child agents receive permitted direct tool names, descriptions and complete input schemas.
Use the advertised registered name: configured entries `personal` and `work` exposing `search` become
`personal_search` and `work_search`, even at the same endpoint. Each entry uses its own connection and
configured-name credential slot. Never infer dispatch identity by splitting the prefix.

Children borrow the parent's tools without connection-management authority. `mcp` and `mcp_use` requests
expand into permitted direct tools; configured-server or `server/tool` selectors narrow access.
Capability ceilings require explicit MCP permission and still constrain exact tool grants.

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

The web Context panel also offers authorization and management actions. Headless hosts never open a desktop browser automatically; use the provider link in Context or the reported authorization URL.

## Measure and reduce what servers cost

Permitted direct tools contribute names, descriptions and full input schemas to main and native child model context. Context shows the active declarations and estimated schema cost. An irrelevant server competes for context and offers tools the model could pick by mistake.

- Run `doompi --explain` to see the per-server token cost. Figures are measured from a real handshake and cached, so the first run for a new server descriptor is slower than later ones.
- Compare selections with `doompi --domains <name[,name...]> --explain` to see what a narrower domain actually saves.
- Reduce the cost by giving domains an `mcp.servers` allowlist in `.doom/domains.yaml` rather than by deleting servers from `.mcp.json`, which keeps them available to other domains.

Keep catalogs out of prompt prose and narrow child subsets. Codemode and tool search remain disabled;
the pinned Pi 1.0.0 source review did not measure savings or establish runtime compatibility.
Filtering activates only when every selected domain declares `mcp`. A selection that mixes an allowlisted domain with one that omits `mcp` stays unfiltered, which is the usual reason an expected saving does not appear.

## Troubleshoot missing tools

1. Confirm the server exists in repository `.mcp.json`, a valid Agent Plugin `mcp.json`, or `mcp-config.yaml` for proxy upstreams.
2. Confirm the active `.doom/domains.yaml` selection permits the direct server or proxy upstream.
3. Check `/mcp status` diagnostics before changing configuration.
4. Reload after a valid change, then confirm the tool catalog again.
5. If Doom Pi was launched with `--no-mcp`, keep MCP disabled unless the user explicitly starts a new session without that flag.

Domain filtering happens before disallowed stdio processes are spawned. Treat allowed stdio configuration as executable code because it runs with the Pi process environment and operating-system privileges. Keep OAuth stores and emitted configuration private.
