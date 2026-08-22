---
name: doompi-author-extension
description: Create or update a DoomPi extension package inside the DoomPi monorepo or as an external npm package. Use for package layout, Pi discovery entries, shared Cordis lifecycle, package-owned Help, and extension verification.
---

# Author a DoomPi extension

Build the smallest extension that owns one clear capability and follows the host lifecycle already used by nearby DoomPi packages.

## Choose the environment

- Inside the DoomPi monorepo, read `AGENTS.md` and `templates/doom-extension/scaffold.yaml` before writing. Use the canonical `scaffold-doom-extension` definition when it fits, then keep only the folders the capability needs.
- Outside the monorepo, create the equivalent public ESM package manually and depend on published DoomPi foundation packages. Never publish `workspace:*` ranges.

Choose the package tier from the capability, not convenience:

- `packages/core/*` for runtime foundations that must always be present.
- `packages/default/*` for normal distribution features selected by default configuration.
- `packages/minor/*` for optional modes.
- `layers/<layer>/*` for selectable layer extensions.

## Workflow

1. Inspect a nearby package with the same host surfaces and reuse its structure.
2. Keep domain contracts in `types`, validation in `schemas`, host-neutral behavior in `services`, infrastructure in `adapters`, and public forwarding files in `src/exports`.
3. Expose one standard Pi factory through `pi.extensions`. Connect it with `connectDoomCordisHost()`, mount one package plugin with `root.plugin()`, and dispose the plugin before releasing the host connection.
4. Consume required cross-package services only inside `cordis.inject(...)`. Return every registration disposer from the injection so provider replacement retracts stale handles.
5. Keep package exports closed and explicit. Add only the dependencies, entries, resources, and folders the capability uses.
6. If the extension contributes Help, put each guide at `src/prompts/<skill-name>/SKILL.md`, publish `src/prompts`, link it from `llms.txt`, and register its exact package name plus `import.meta.url`.
7. Run the repository checks or the equivalent standalone package checks before publishing.

Read [references/extension-contract.md](references/extension-contract.md) for the concrete package, lifecycle, and verification contract.
