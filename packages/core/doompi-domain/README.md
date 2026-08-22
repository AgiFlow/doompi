# @agimon-ai/doompi-domain

Domain selection for [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) sessions.

**Domains** are one of the four axes of a DoomPi selection, alongside the major mode, the profile,
and the minor modes. Unlike a major mode, domains compose: a session selects a set of them, and
the union of what they contribute is what the model sees.

```yaml
# .doom/domains.yaml
plugins:
  entries:
    frontend: plugins/frontend
    infra: plugins/infra
domains:
  development:
    description: Application code, tests, and review tooling.
    plugins: [frontend]
    mcp:
      servers: [code-intel]
  platform:
    description: Deployment, infrastructure, and incident tooling.
    plugins: [infra]
aliases:
  everything: [development, platform]
```

## What it registers

| Surface                     | Behavior                                                      |
| --------------------------- | ------------------------------------------------------------- |
| `/domains`                  | prints the selection, or switches to `name[,name...]`         |
| `/domains` with no argument | opens a multi-select picker in the TUI                        |
| `list_domains` voice tool   | returns the active, effective and available domains           |
| `switch_domains` voice tool | validates a selection and queues the switch                   |
| autocomplete                | comma-triggered completion of domain names inside `/domains`  |
| `resources_discover`        | re-answers with the current selection's skills after a reload |

When the `@agimon-ai/doompi-help` minor mode is active, this package contributes the
`doompi-author-domain` skill. It provides package-owned guidance for plugin catalogs, domain
filters, aliases, defaults, shared skills, and MCP scopes in `domains.yaml`. The contribution is
registered through the session's `doom/help` Cordis service and is withdrawn with this package's
plugin fiber.

## What a switch stages

A domain switch is not just a config write, which is why it does not live in
`@agimon-ai/doompi-config/selectionSwitch` with the major-mode and profile switches. Applying a
selection:

- materializes any remote (Git or npm) plugins the selected domains name into a content-addressed
  cache guarded by an install marker;
- discovers the exact `SKILL.md` files behind the selection, through a manifest cache keyed by
  worktree so a second session does not rescan the tree;
- adapts each plugin's Claude-authored agent definitions into the form Pi loads, and stages them
  privately (`0600`) beside a dispatcher agent;
- merges the repository and legacy plugin `.mcp.json` layers, and validates root `mcp.json` for
  schema-gated Agent Plugins v1 (including plugin-relative commands, data directories, and transport
  normalization);
- applies the selected domains' MCP allowlists and rewrites the proxy's upstream list into a
  private per-run config; and
- atomically stores an immutable MCP projection in harness state, then reloads Pi. The replacement
  Config factory publishes that snapshot through the session Cordis registry for DoomPi MCP to
  consume; Domain never reaches into the live MCP runtime.

An allowlist only takes effect once **every** selected domain declares one. Mixing a scoped domain
with a domain that has not opted in leaves the session unfiltered, so an unmigrated domain cannot
silently lose its tools.

## Switching from voice

The voice tool never applies a switch itself. It plans the transition, parks the validated
selection in a TTL-bounded store, and sends `/domains --voice-switch-token=…` back as a follow-up,
so the reload happens inside a command handler where it can be the terminal action. The selection
travels in the store rather than in the follow-up text, and the token is bound to the session that
minted it.

## Installation

DoomPi depends on this package and activates it as fixed host core, so a DoomPi install already has
it. It is not selectable from `.doom/modes.yaml`; it reads `.doom/domains.yaml`.

## License

MIT
