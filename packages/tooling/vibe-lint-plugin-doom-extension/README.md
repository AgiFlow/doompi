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

### Source structure and public entries

- `src/extensions/pi.ts`, `server.ts`, and `web.ts` are direct host entries, built or source-bundled without export wrappers.
- `src/controllers/` translates API, typed method, and command requests into service calls.
- `src/services/{serviceName}/index.ts` owns package logic; its `type.ts` owns local service contracts. Filesystem, network, process work, and Cordis service implementations belong here.
- `src/models/` owns state; `src/tools/` declares tools that consume services and models.
- `src/constants/`, `src/schemas/`, and `src/types/` hold shared data, validation, and cross-capability types.
- Flat `src/exports/*.ts` modules expose selected reusable capabilities through pure re-exports. They do not forward extension, browser, or executable entries.
- `src/web/`, `src/tui/`, and `src/bin/` retain browser presentation, terminal presentation, and standalone executable composition.

The preset rejects `adapters`, `container`, `containers`, `commands`, and `providers` source roots. It also rejects nested exports and imports through old compatibility wrappers. Relative imports omit file extensions and `/index`; `clean-import-path` is enabled at error severity.

Dependencies point inward: controllers and tools consume services/models, services consume models and other services, models consume schemas/types/constants, schemas consume types/constants, and types consume constants. Extension and executable roots assemble the graph without importing public export wrappers or each other. The direct web entry retains the same browser-safe dependencies as `src/web`.

### Plugin lifecycle and HTTP APIs

Use `definePiExtension`, `defineServerPlugin`, and `defineWebPlugin` at direct host entries. Named contribution objects handle static declarations; typed per-mount factories construct shared state. Pi factories and server scope factories may return a promise, which the helper awaits before registration and readiness. Commands and static tools use declaration arrays instead of registrar callbacks. Pi tools may also supply a `PiToolCollection` with `snapshot()` and `subscribe(listener)` for changing catalogs. Reuse immutable declarations across snapshots. A new declaration for a registered name replaces its implementation and aborts old invocations. Withdrawn tools are cancelled and unavailable, and the helper owns subscription cleanup. Pi minorModes may use PiMinorModeCollection snapshot()/subscribe(listener) for changing catalog availability; the helper owns attachment, withdrawal, provider rebinding, and subscription cleanup. Cordis service implementations are included through the `services` contribution array.

Pi and server lifecycle hooks are optional: `onStart` runs after registration, `onStop` stops work before registrations are removed, and `onDispose` releases final instance resources. Helpers await startup, abort the instance signal during shutdown, own registration cleanup, and roll back failed mounts. Do not generate empty hooks or duplicate host bootstrap and disposal wiring.

HTTP controllers export `DoomApi` declarations for the server plugin's `api` arrays. Declare one `doompiServer` block with `entry: './src/extensions/server.ts'`, its built dist path, and supported `global`, `workspace`, and `session` scopes. The `package-api-manifest` rule rejects the legacy `doompiApi` field. Browser composition lives directly at `src/extensions/web.ts`, referenced by `doompiWeb.client` and bundled from source.

### Cordis and runtime ownership

The shared helpers own the runner host, leases, child fibers, and cleanup. Feature entries declare capabilities without creating a Cordis Context or manually acquiring a host lease. Service implementations publish from their owned context. Required service consumption belongs in an owning injection; bindings must be released when their provider disappears.

Pi EventBus use is reserved for the versioned host query. Same-runner runtime protocol imports and live `global` or `globalThis` capability registries are rejected. Reload handoff and bootstrap claims remain narrow runtime exceptions with their existing lifetime and identity checks.

## Public API

The default export is the Vibe-Lint plugin contract. Named exports include `doomExtensionPlugin`, `rules`, `recommended`, `migration`, and the rule definitions re-exported by the package entry point.
