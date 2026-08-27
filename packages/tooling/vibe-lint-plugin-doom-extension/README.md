# @agimon-ai/vibe-lint-plugin-doom-extension

Deterministic Vibe-Lint rules for publishable DoomPi extension packages.

This package is alpha software. Its rules and package contracts may change between alpha releases. It requires Node.js 22.19.0 or newer and the `@agimon-ai/vibe-lint` peer version declared in its package metadata.

## Install

```bash
pnpm add -D @agimon-ai/vibe-lint @agimon-ai/vibe-lint-plugin-doom-extension
```

This installs the Vibe-Lint CLI and the DoomPi extension rule plugin as development dependencies.

## Configure

Add the plugin and one preset to `vibe-lint.config.yaml`:

```yaml
plugins:
  - core
  - doom-extension

extends:
  - core/recommended
  - doom-extension/recommended
```

Vibe-Lint resolves the short name `doom-extension` to this package. The recommended preset enables the extension contract at error severity. For an existing package migration, replace `doom-extension/recommended` with `doom-extension/migration`. The migration preset enables the same rules at warning severity.

Run the configured checks with:

```bash
pnpm exec vibe-lint check .
```

The command checks the current directory using its resolved Vibe-Lint configuration. The plugin reports violations but does not rewrite package files.

## Enforced package contracts

The preset checks the canonical DoomPi source layout, layer dependencies, public exports, schemas, services, Pi entry points, peer versions, Cordis ownership, lifecycle cleanup, package metadata, optional HTTP APIs, and optional web cockpit plugins.

### Help prompts

Package-owned Help prompts live at `src/prompts/<prompt-name>/SKILL.md`. The `doom-prompt-shape` rule checks the prompt directory name, frontmatter, `llms.txt` link, and publish allowlist entry. A prompt may keep support material in adjacent `references`, `scripts`, `assets`, and `agents` directories.

### HTTP APIs

A package that serves HTTP declares `doompiApi` in `package.json`. The declaration names a base path and an entry for each supported scope: `session` for the session server and `hub` for the cockpit hub.

`package-api-manifest` checks the base path, each declared entry, and the publish allowlist for the built module imported by the host. `package-api-entry` checks that the entry exports the named `api` value expected by generated route modules. Installation does not validate this manifest, so an invalid published path may not surface until a host loads the package.

### Cordis and runtime ownership

The Cordis rules require one runner-owned host. They check host-first and finalizer-last activation, one captured feature lease and plugin fiber, and shutdown of the fiber before its lease. Providers may publish only from the context owned by their mounted plugin or an owned injection. Required services belong in `ctx.inject`. Stable Pi wrappers must identity-check and clear their active binding during injection cleanup when a provider unloads.

Pi EventBus use is reserved for the versioned host query and is followed through local aliases and helper parameters. Same-runner runtime protocol imports are rejected except for passive protocol error classes. Live `global` and `globalThis` capability registries are rejected. The reload-handoff and bootstrap-claim modules remain narrow exceptions only while their TTL, generation, identity, or release fences remain intact.

## Public API

The default export is the Vibe-Lint plugin contract. Named exports include `doomExtensionPlugin`, `rules`, `recommended`, `migration`, and the rule definitions re-exported by the package entry point.
