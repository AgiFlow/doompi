# @agimon-ai/doompi-mcp

Domain-aware MCP selection for DoomPi and a standalone MCP adapter for Pi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The package removes disallowed servers before any stdio process is spawned. A filtered server is
absent rather than merely hidden from the model.

> **Alpha:** configuration and adapter contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 1.0.0 and Pi TUI 1.0.0

## Install

`doompi init` and `dpi init` include this adapter in `default.packages` in `.doom/modes.yaml`.
Remove it or move it to a named layer to change which major modes load it. When loaded in DoomPi,
domain selection controls server access. For plain Pi:

```bash
pi install npm:@agimon-ai/doompi-mcp
```

| Entry                                 | Purpose                                                    |
| ------------------------------------- | ---------------------------------------------------------- |
| `@agimon-ai/doompi-mcp/extensions/pi` | Standard Pi adapter using repository and domain MCP config |
| `@agimon-ai/doompi-mcp`               | Library API                                                |
| `@agimon-ai/doompi-mcp/projection`    | Neutral projection adapter and Agent Plugin normalization  |

## Configure direct servers

Repository `.mcp.json` entries describe direct MCP servers:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Selected legacy plugins may also provide root `.mcp.json`. A schema-gated Agent Plugin v1 instead
provides root `mcp.json`. Doom validates its portable contract, supplies private persistent
`PLUGIN_DATA`, and resolves plugin-relative stdio commands and working directories. It also
normalizes `streamable-http` for the embedded runtime. Invalid portable server entries are isolated
from the other entries in that plugin.

Proxy upstreams are read from `mcp-config.yaml`. Domains can select direct `servers` and proxy
upstreams separately in `.doom/domains.yaml`:

```yaml
# .doom/domains.yaml
domains:
  development:
    description: Repository development tools.
    mcp:
      servers: [filesystem]
      proxy: [github]
```

An absent or empty allowlist retains configured entries. Use `doompi --no-mcp` when no MCP server
should load. In plain Pi mode, no DoomPi domain allowlist is applied.

Within DoomPi, this package consumes the immutable `doomMcpProjection` service published on the
session Cordis root. Each Pi reload disposes the old injected runtime before the replacement binds.
Downstream clients run in-process through `@agimon-ai/mcp-proxy`; this adapter does not start its
Hono server.

## Direct tools and configured identity

Main sessions and native child agents receive permitted named MCP tools with their descriptions
and complete input schemas. Names use the configured entry prefix, not the downstream-reported
server name: `personal/search` is exposed as `personal_search` and `work/search` as `work_search`.
Non-alphanumeric prefix characters become underscores, preserving existing names and collision
diagnostics.

Two configured entries may point to the same URL with different accounts. Each uses its own
configured-name connection and credential slot. Requests retain the exact configured name and
original downstream tool name; tool prefixes are not parsed to route calls.

Children borrow the parent runtime. Requested `mcp` or `mcp_use` groups expand into permitted
direct tools; `mcpDirectTools` selectors (`*`, a configured server, or `server/tool`) narrow that
set. Capability ceilings must explicitly allow MCP and still constrain the selected tools.
Children cannot manage the parent's connections. Remote `mcp_use` remains a compatibility route,
not the default native model declaration.

Full schemas cost context tokens. Select domains and child subsets rather than hiding tool
availability or repeating catalogs in prompt prose. Codemode and tool search remain disabled;
the Pi 1.0.0 source review did not measure savings or justify enabling them.

## Inline Apps (development)

The conversation renderer recognizes standard `_meta.ui.resourceUri`, deprecated
`ui/resourceUri`, and ChatGPT `openai/outputTemplate` declarations. HTML stays inside
an opaque, sandboxed inline frame; ordinary text results remain available. Browsers
without iframe CSP enforcement use the text fallback.

Apps open read-only, including replayed history. Enable interactions to authorize a
fresh connection-bound lease. Each tool call and attributed follow-up requires host
confirmation and the existing session admission checks. Calls are limited to current,
app-visible tools on the original configured server. Visibility is not consent.
Private result metadata and bounded widget state are not injected into model content.
Reopening a widget reads its retained result and state, never reruns the original tool.

`window.openai` is present in every widget, beside the MCP Apps bridge, so standard Apps
built on the ChatGPT SDK work too. Only ChatGPT widgets receive `toolOutput` globals updates
after their own `callTool`. Each App root gets a `light`/`dark` class, `data-theme` and
`color-scheme` (an App's own class or `data-theme` is kept), and theme changes sync live.
A tool result that rendered an App stays behind the card toggle unless the call failed.

The ChatGPT adapter implements tool input/output and private metadata globals, globals
updates, `callTool`, `setWidgetState`, `sendFollowUpMessage`, inline display mode, height,
close, and confirmed external links. File libraries, checkout, accounts, modal/fullscreen
modes, stable custom origins, sampling, and automatic model-context updates are unsupported.

The runtime pins published `@agimon-ai/mcp-proxy@0.32.5` for Apps capability
negotiation, private result capture before output guarding, and upstream request
cancellation. Model-facing output remains guarded; retained App results are bounded
separately. No local proxy dependency or spill-file reads are used.

Run from the repository root:

```sh
pnpm --filter @agimon-ai/doompi-mcp test
pnpm --filter @agimon-ai/doompi exec playwright test --config playwright.app.config.ts inlineMcpSandbox.spec.ts
pnpm nx run @agimon-ai/doompi:test:app
```

The stdio fixture verifies discovery, visibility, resource reads, pre-guard private
results, and upstream cancellation. Browser tests cover sandbox/bootstrap isolation
and standalone exported widgets. The production conversation fixture uses an isolated
home and a local scripted model to verify standard and ChatGPT Apps, confirmed callbacks
and attributed follow-ups, private metadata exclusion, saved state, read-only replay
without rerunning tools, and a real DoomPi-exported session widget.

## Commands

```text
/mcp
/mcp status
/mcp auth <server>
/mcp reload
```

In a TUI, the bare `/mcp` command opens the interactive overlay. The web Context panel lists
configured servers and their named tools, including authorization and management actions. Open a
tool to inspect its description, full input schema, warnings and estimated schema tokens.
Authorization sends one `/mcp auth <server>` prompt frame; headless hosts never open a desktop
browser automatically.

The compact `doom-mcp-session-auth` status carries configured names, states, safe authorization
URLs and tool identities/estimates. It excludes credentials and credential-store data. Repository
catalog and authorization APIs remain separate from this live-session view.

## Credentials and trust

Allowed stdio entries execute their configured commands with the Pi process environment and
operating system privileges. Review configuration as executable code.

OAuth credentials use the operating system keyring when available. The private-file fallback is
stored under `~/.mcp-proxy/oauth` with owner-only permissions. Credentials remain machine-wide and
keyed by server name, while their upstream URL binding prevents blind replay to another endpoint.
Treat both the configuration and credential store as sensitive.

The default OAuth callback is `http://127.0.0.1:19876/callback`. Authorization therefore requires the
browser and DoomPi runtime to share that loopback network namespace. A remote browser cannot complete
the callback when its `127.0.0.1` resolves to another machine or container.

## Public API

```ts
import { buildMcpConfigGroups, readCachedCatalog, registerMcpExtension, toPiToolName } from '@agimon-ai/doompi-mcp';
import type { McpAllowlist, McpSessionConfig } from '@agimon-ai/doompi-mcp';
```

`doompi --emit-mcp <directory>` emits the resolved MCP configuration to the target directory
without launching a model.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT

The direct `src/extensions/` entries declare host contributions. MCP session state and connection behavior live in named service folders; controllers handle commands and API requests. `tools/` produces typed declarations, and `exports/` exposes reusable public APIs.

Pi tools use a live collection. The helper subscribes to discovery changes and owns registrations and cleanup. Unchanged tools retain their declaration identity across reconnects. Removed tools are unavailable, and incompatible schema reuse stays hidden until the runtime is relaunched. Renderer callbacks enter through the Pi extension, keeping services independent of terminal presentation.
