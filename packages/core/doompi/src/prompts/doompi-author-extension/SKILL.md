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
- `packages/clients/*` for standalone client-facing processes.
- `layers/<layer>/*` for selectable layer extensions.

## Workflow

1. Inspect a nearby package with the same host surfaces and reuse its structure.
2. Put logic in `services/<serviceName>/index.ts`, service ports in `type.ts`, mutable state in `models`, request handlers in `controllers`, and tools in `tools`. Keep reusable types, schemas, and constant data in their named folders. Do not create `adapters`, `container`, `commands`, or `providers` roots.
3. Implement direct host entries in `src/extensions/pi.ts`, `server.ts`, or `web.ts` with `definePiExtension`, `defineServerPlugin`, or `defineWebPlugin`. Entries compose controllers, tools, and services. Build entries directly with tsdown, separately from flat public forwarding files in `src/exports`.
4. Return typed contributions from a named declaration or per-mount factory. Factories may be async. Use optional `onStart`, `onStop`, and `onDispose` hooks for lifecycle work; helpers own Cordis initialization, registration, readiness, and cleanup.
5. Put provider plugins in services and include them in the `services` contribution array. Consume required providers inside an owning injection with the corresponding `require...` accessor. The helper handles optional providers for native contributions such as resources and minor modes.
6. Keep package exports explicit and flat, with only reusable APIs. If the extension contributes Help, publish `src/prompts/<skill-name>/SKILL.md`, link it from `llms.txt`, and declare its descriptor in `resources` with the exact package name and `import.meta.url`.
7. Run the repository checks or equivalent standalone package checks before publishing.

Read [references/extension-contract.md](references/extension-contract.md) for the concrete package, lifecycle, and verification contract.
