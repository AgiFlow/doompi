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

`src/exports/` is the only executable public surface: pure re-exports, one file per
`package.json` exports subpath, mirroring the subpath tree. There is no
`src/index.ts` and no `src/extensions/`.

`src/prompts/<prompt-name>/SKILL.md` is the package-owned Help resource surface.
It is not an executable layer. Every prompt directory is kebab-case, is linked
from `llms.txt`, and ships through the exact `src/prompts` files allowlist entry.
Package-root `skills/**` may still hold runtime-discovered Pi skills.

Dependencies point inward. A layer may import only from itself and the layers
below it:

| layer        | may import                                                        |
| ------------ | ----------------------------------------------------------------- |
| `types/`     | `types`                                                           |
| `schemas/`   | `schemas`, `types`                                                |
| `services/`  | `services`, `schemas`, `types` — no `node:*`, no Pi, no container |
| `adapters/`  | `adapters`, `services`, `schemas`, `types`                        |
| `commands/`  | `commands`, `services`, `schemas`, `types`                        |
| `tui/`       | `tui`, `services`, `schemas`, `types`                             |
| `container/` | everything above                                                  |
| `exports/`   | everything above                                                  |

`src/adapters/pi/**` is the composition root and is exempt: it wires commands
and TUI to the host.

`bin/` and `extensions/` are transitional. Never introduce `agents`, `api`,
`common`, `components`, `config`, `delegation`, `entries`, `helpers`,
`interfaces`, `misc`, `protocol`, `runs`, `shared`, `slash`, `store`, `tool`,
`utils`, or `workflow` as a `src/` root — `doom-folder-layout` rejects them.

Reference implementation: `packages/default/doompi-mcp/` and
`packages/core/doompi-config/`.

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

Packages still on the pre-`src/exports` layout extend `doom-extension/migration`,
which reports the structural rules as warnings. They are being moved one at a
time; a package graduates by switching to `doom-extension/recommended`. A
`vibe-lint/coverage` warning means the file sits in a root the canonical
vocabulary does not cover — it is a migration to-do, not a config gap.

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
