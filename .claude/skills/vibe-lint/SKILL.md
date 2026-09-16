---
name: vibe-lint
description: 'Architectural review and design-pattern enforcement for this repository, run as a CLI. Hooks already surface patterns before an edit and diagnostics after a batch, so reach for this when you need an explicit sweep, want to know which rules govern a file before writing it, or are changing the canonical package layout. Trigger on vibe-lint, architectural review, design patterns, boundary violation, canonical layout, src/exports, doom-folder-layout, public-export-boundary, or a request to check code against repository rules.'
---

# vibe-lint

Enforces the DoomPi package architecture. It is a CLI, not an MCP server — there
are no `mcp__vibe-lint__*` tools, and the architect MCP it replaced is gone.

## Never trust a bare directory check

`vibe-lint check <dir>` resolves the **changed** file set. On a clean tree it
prints `No violations found` while the tree is full of them. Always pass an
explicit file list:

```bash
# Whole-repo sweep (this is what CI runs)
pnpm lint:vibe --preflight-only

# A specific set
git ls-files 'layers/team/doompi-team/src/**/*.ts' > /tmp/f.txt
pnpm vibe-lint check --preflight-only --files-from /tmp/f.txt

# Which rules govern a file, before writing it
pnpm vibe-lint check --rules-only packages/default/doompi-mcp/src/services/mcpCatalog.ts
```

`--preflight-only` runs the deterministic rules with no LLM. Prefer it: it is
reproducible, needs no provider, and is what the hooks and CI use.

`pnpm exec vibe-lint` does **not** work here — pnpm does not link bins for
`workspace:*` dependencies whose `dist/` is built after install. Use the
`pnpm vibe-lint` / `pnpm lint:vibe` root scripts.

## The canonical package layout

`src/exports/` is the executable public surface: pure re-exports, one file per
`package.json` export subpath. `src/extensions/` is the host composition surface.
Every scanned route directly default-exports one typed `define*` declaration and
contains no named exports or freeform implementation. Shared implementation lives
in `src/services` or shared contracts; implementation used by one surface lives in
a private `_folder` beside its route, `_components` for components and `_lib` for
everything else. The build never scans a `_folder`, at any depth, so nothing in
one is a contribution. There is no `src/web` root in an extension package:
browser code colocates the same way.

`src/prompts/<prompt-name>/SKILL.md` is the package-owned Help resource surface.
Every prompt directory is kebab-case, is linked from `llms.txt`, and ships through
the exact `src/prompts` files allowlist entry. Package-root `skills/**` may still
hold runtime-discovered Pi skills.

Dependencies point inward. A layer may import only from itself and the layers
below it:

| layer        | may import                                                                |
| ------------ | ------------------------------------------------------------------------- |
| `types/`     | `types`                                                                   |
| `schemas/`   | `schemas`, `types`                                                        |
| `services/`  | `services`, `schemas`, `types` — no `node:*`, no Pi, no container         |
| `adapters/`  | `adapters`, `services`, `schemas`, `types`                                |
| `commands/`  | `commands`, `services`, `schemas`, `types`                                |
| `tui/`       | `tui`, `services`, `schemas`, `types`. Published terminal primitives only |
| `container/` | everything above                                                          |
| `exports/`   | everything above                                                          |

`src/extensions/**/root.cli.ts` and `root.server.ts` construct scoped shared
state, services, startup work, and lifecycle. Named routes own each tool, command,
hook, API, channel, method, provider, resource, shortcut, and frontend contribution.
Non-default cardinality uses `defineRoutedContribution(..., { cardinality })` on
the standard surface. Never create `*-optional`, `*-catalog`, `tool-collection`,
`extra.*`, `src/tools`, or `src/controllers` paths.

Reference implementation: `layers/team/doompi-team/src/extensions/`.

## Where the rules live

Rules are TypeScript, never YAML:

- repository-wide → the published `@agimon-ai/vibe-lint` package (its `core` rules ship compiled in
  `node_modules`; they are not in this repository)
- DoomPi extension packages → `packages/tooling/vibe-lint-plugin-doom-extension/src/rules/`, including
  the `web-plugin-*` rules that govern a package's `web/` cockpit plugin
- the cockpit host and the shared components package → `packages/tooling/vibe-lint-plugin-doom-web/src/rules/`

The shared layer graph, design patterns, and Pi-entry overrides live once in
`packages/tooling/vibe-lint-plugin-doom-extension/src/configs/`. A package's
`vibe-lint.config.yaml` should be about ten lines — `plugins`, `extends`, and
only genuinely package-specific `rules`/`overrides`. If you are copying a
boundary block between packages, put it in the plugin preset instead.

YAML can express severity, rule options (tuple form replaces options wholesale —
there is no deep merge), `boundaries`, `overrides`, `patterns` (advisory prose,
not rules), `ignore`, `plugins`, and `extends`. It cannot define a rule.

Do not add `root: true` to a package config: it severs the package from the
repository config, including its `llm.providers`.

## Migration state

The canonical routed layout is required. Legacy `extra.*`, `src/tools`, and
`src/controllers` paths are deterministic errors. A `vibe-lint/coverage` warning
means the file sits in a root the canonical vocabulary does not cover. Fix the
layout or rule source instead of adding package-local allowances.

## Automatic checks

Generated into `.claude/settings.json` from `.doom/hooks.yaml` — edit the
registry, then run `node scripts/emit-hooks.mjs --write`.

1. **PreToolUse** (`Edit|Write|MultiEdit`) — injects the design patterns for the
   file about to be edited.
2. **PostToolBatch** — reports deterministic preflight diagnostics for the files
   just changed. Errors come back inline; warnings are written to a temp JSON
   file whose path is reported with its line and byte count.

Set `DOOMPI_HOOK_GROUPS` to a comma-separated list to run only some groups;
unset means all. There is no Stop hook — the dispatcher has no
`claude-code.stop` case.

Findings are there to improve the code. Fix them at the source; do not route
writes around the hook.
