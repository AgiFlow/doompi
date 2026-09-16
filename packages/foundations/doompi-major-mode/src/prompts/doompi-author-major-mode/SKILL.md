---
name: doompi-author-major-mode
description: Configure DoomPi default packages, layers, extensions, hook groups, and named major modes. Use when creating or editing ~/.pi/.doom/modes.yaml or a repository's .doom/modes.yaml, choosing a default mode, or diagnosing which behavior a mode activates.
---

# Author DoomPi major modes

Use `modes.yaml` only for runtime composition. Major modes choose ordered layers, and layers choose
Pi extensions, extension packages, and hook groups. Domains configure plugin content and MCP access;
profiles configure personas and environment defaults.

## Workflow

1. Read both `~/.pi/.doom/modes.yaml` and the repository's `.doom/modes.yaml` when they exist.
2. Decide whether the change belongs in the personal defaults or only in the current repository.
3. Preserve unrelated definitions and authored array order.
4. Put unconditional packages in `default.packages`, reusable behavior in `layers`, and selections
   under `majorMode`.
5. Write new modes as mappings with a useful `description` and an ordered `layers` array.
6. Put package-owned settings under that package's `config` mapping. Do not add layer-level `config`
   or the removed `targets` field.
7. Check the result with `doompi --major-mode <name> --explain`. Use `doompi sync --check` when the
   change affects installed packages or the synchronized matrix.

Relative local paths resolve from the repository root for repository configuration and from
`~/.pi/.doom` for personal configuration. A repository definition replaces a personal definition
of the same name as a whole value, so never assume nested fields merge.

Read [references/modes-contract.md](references/modes-contract.md) before editing package entries,
local extension paths, hook-only layers, inherited definitions, or tombstones.
