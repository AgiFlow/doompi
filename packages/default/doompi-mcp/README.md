# @agimon-ai/doompi-mcp

Domain-aware MCP selection for DoomPi and a standalone MCP adapter for Pi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The package removes disallowed servers before any stdio process is spawned. A filtered server is
absent rather than merely hidden from the model.

> **Alpha:** configuration and adapter contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.2 and Pi TUI 0.84.2

## Install

DoomPi includes the standard adapter in every composition; domain selection controls access. For
plain Pi:

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

## Commands

```text
/mcp
/mcp status
/mcp auth <server>
/mcp reload
```

The interactive status and authentication surfaces require a TUI. Resolved configuration and
catalog APIs remain usable by headless hosts.

## Credentials and trust

Allowed stdio entries execute their configured commands with the Pi process environment and
operating system privileges. Review configuration as executable code.

OAuth credentials use the operating system keyring when available. The private-file fallback is
stored under `~/.mcp-proxy/oauth` with owner-only permissions. Treat both the configuration and
credential store as sensitive.

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
