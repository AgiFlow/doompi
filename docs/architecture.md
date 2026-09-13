# DoomPi architecture

[Back to DoomPi](../README.md)

DoomPi has two runtime paths around the same resolved configuration. Interactive terminal launches compose Pi extensions and let Pi own extension loading, replacement, and the TUI runner. Headless launches run the agent harness directly, install package contributions through DoomPi's kernel and server facets, and expose client-neutral HTTP and WebSocket services. Both paths use the same package selection, synchronized generation, and composition identity.

The architecture follows five boundaries:

1. **One canonical selection:** launcher, synchronization, server admission, and child startup resolve the same defaults, layers, modes, and package provenance.
2. **Each runtime owns execution:** Pi executes interactive extension factories; the headless host executes kernel contributions and server facets.
3. **Cordis owns service lifetimes:** independently loaded package facets publish versioned services instead of importing selectable implementations.
4. **The kernel owns headless activation:** session-scoped tools, commands, resources, hooks, restrictions, and activities are gated as one coherent selection.
5. **Repository identity owns generated state:** synchronized artifacts are immutable and selected through a validated repository or worktree registration.

This guide explains those runtime boundaries and the contributor invariants they create. [Composition and runtime bundling](bundling.md) explains the artifact pipeline in reader-facing terms.

## System model

Configuration resolution produces one ordered package composition and one SHA-256 fingerprint. Synchronization projects that composition into artifacts for both runtime paths:

```text
resolved configuration and runtime selection
                    |
                    v
      resolveExtensionComposition()
          |         |          |
          |         |          +-- composition fingerprint
          |         +------------- server facet owners
          +----------------------- Pi parent and child activation
                    |
                    v
              doompi sync
                    |
          immutable generation
       +------------+-------------+
       |            |             |
       v            v             v
 Pi bootstraps   server.bundle   web assets and
 and bundles      and facets      API contracts
       |            |             |
       v            v             v
  Pi runner     headless hub   web or desktop
                    |
             HeadlessSessionHost
                    |
             DirectHarnessRuntime
```

An interactive Pi activation begins with `cordisHost` and ends with `cordisFinalizer`. The resolver places fixed, default, layer, and selection-specific entries in canonical order. Default packages run before packages from selected named layers.

The server bundle records the built server facet for each selected package, its valid scopes, ownership, and required status. A headless server admits only a synchronized bundle whose generation and fingerprint match the validated registration. Session hosts retain eligible candidates so the kernel can apply selection changes without importing a different generation.

## Configuration and package boundaries

| Location             | Responsibility                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/core/*`    | Runtime foundations, shared contracts, the DoomPi distribution host, and kernel/server composition. |
| `packages/default/*` | Default distribution features selected through configuration.                                       |
| `packages/minor/*`   | Optional modes selected through configuration.                                                      |
| `packages/clients/*` | Standalone presentation clients, currently the web presentation server and desktop shell.           |
| `layers/<layer>/*`   | Selectable higher-level extensions.                                                                 |
| `packages/tooling/*` | Repository-owned development tools that are not part of the runtime package graph.                  |

The published `@agimon-ai/doompi` package owns the CLI, interactive host, headless server runtime, and their fixed core dependency set. There is no standalone server package under `packages/clients`; the server entry is built and published by `@agimon-ai/doompi`. Selectable packages remain outside that private dependency closure. This keeps the distribution hosts stable while allowing a repository to choose its features.

`.doom/modes.yaml` defines an optional default package list, named layers, and major modes. Configuration is resolved with these rules:

- Home configuration is loaded before repository configuration.
- A repository `default` declaration replaces the home default as one package list.
- A repository layer or major mode replaces the same named home entry. A top-level `null` removes it.
- A major mode lists layers in activation order.
- Package `config` remains opaque data owned by that package.

Configured feature packages contribute factories through their standard `package.json` `pi.extensions` entries. Direct extension paths are Pi-compatible entries. Fixed host packages cannot be selected again as features.

Package-owned Help guidance lives under `src/prompts/<prompt-name>/SKILL.md`.
These files are published resources, not executable architecture layers. Each
owning package links its prompts from `llms.txt` and registers their descriptors
through the shared Help service. Package-root `skills/**` remains available for
skills that Pi discovers and executes directly.

Selectable packages resolve from the consumer repository through normal `node_modules` lookup or Pi's project-local `.pi/npm` store. Fixed host entries may fall back to the root package dependency closure. When a required bare package is missing, DoomPi asks Pi to resolve `npm:<package-name>` and reuses the installed result. Optional packages and local paths are not installed automatically.

### Cockpit plugin source

A package's browser plugin keeps `src/extensions/web.ts` as its composition entry and groups implementation by responsibility: `lib/` for pure calculations, `api/` for browser transports, `stores/` for reactive state and channel reducers, `hooks/` for React subscriptions and effects, and `components/` for rendering. Imports point inward in that order. Shared wire contracts stay in `src/types/`, while server controllers stay outside the browser tree. Omit empty folders and keep state-specific types beside the store that owns them.

## Runtime ownership

`@agimon-ai/doompi-core` contains neutral contracts and reusable runtime systems: the kernel, headless session host and manager, direct harness integration, server facet loading, package API hosting, protocol handling, persistence, and Pi integration. Feature packages own policy and concrete services. `@agimon-ai/doompi-minor-mode` owns the mode catalog, commands, projection, and selection state.

`@agimon-ai/doompi` owns CLI commands and distribution composition. Its `src/builders/cli`, `src/builders/server`, and `src/builders/web` directories own interactive composition, headless server assembly, and browser asset generation. The server builder creates one headless hub, admits synchronized global and workspace scopes, creates independent session hosts, mounts scoped package APIs and channels, and starts the authenticated protocol listener. Shared compiler, input, and cache mechanics live in `src/compiler`. Shared selection data and persisted state live in `src/composition`. Command handlers, help, options, and presentation are collocated under `src/cli/commands/<name>`, while the server entry and arguments live under `src/cli/server` and `src/bin/serve.ts`.

## Canonical composition

`resolveExtensionComposition()` is the authority for selected package provenance and the interactive runtime graph. One call returns:

- the selected major mode and ordered layer occurrences;
- every authored package or extension occurrence, including configuration and resolution outcome;
- the interactive parent factory activation list;
- the detached-child factory activation list; and
- one deterministic composition fingerprint.

Authored occurrences remain visible even when the same package appears more than once. Factory activation is deduplicated separately by canonical resolved path, with the first authored occurrence winning. This preserves configuration provenance without activating the same module twice.

Synchronization also scans those selected package roots for `doompiServer` declarations. It builds one `server.bundle.json` that maps each built facet to its owning modes and layers, supported scopes, and required status. The composition fingerprint remains the identity used by launcher planning, synchronized bundles, server admission, persisted selection, drift detection, and transition classification.

## Runtime artifacts and synchronization

The `doompi` launcher provisions the defaults plus the active mode layers. It builds an aggregate Pi runtime bundle from the canonical activation plan and falls back to the individual ordered entries if bundling is unavailable.

`doompi sync` provisions the defaults plus every declared named layer and stages one complete immutable generation in the home-scoped repository/worktree namespace. The generation contains state, Pi bootstraps and mode bundles, package resources, web assets, `server.bundle.json`, built server facets, and exported API contracts.

Publication follows three steps:

1. Build and validate every artifact. Remove the unpublished generation if this fails.
2. Write the validated registration atomically, so readers select a complete generation.
3. Retain one superseded generation and attempt to remove older ones. Report cleanup failures without failing the published sync.

Published artifacts are not mutated in place.

Repository and worktree identities are the routing boundary. Consumers accept state only through the exact validated registration for the nearest repository. Registration validation confines paths to the generation, verifies the state hash and repository identity, and pins the DoomPi package root, version, manifest, Pi entry, and server bundle that produced it. Missing, malformed, foreign, traversing, symlinked, stale, and unsupported registrations fail closed. Consumers do not guess another repository, source checkout, legacy state file, or global `current` directory.

Synchronized state maps composition fingerprints to Pi bundles and compiler manifests. The bootstrap has its own manifest. Server admission separately validates the registered server bundle's generation and fingerprint before importing any facet. Immutable compiler artifacts may be reused through the shared cache, but publication and runtime selection remain repository-isolated.

The package bootstrap is inert outside a synchronized repository. Inside one, it imports only the package and bootstrap pinned by the validated registration and never compiles during startup. An unusable registration, bootstrap, or recorded bundle reports:

```text
doompi could not read its synchronized state. Run doompi sync.
```

`doompi init` owns the global Pi dispatcher, user settings integration, and default theme. `doompi sync` requires that integration for persisted mode but does not rewrite it. It reconciles existing repository Pi settings and removes a legacy repository alias. `dpi` supplies its overlay in memory and uses the same repository-isolated publication without requiring persisted settings.

## Headless server and presentation clients

The headless server runtime belongs to `@agimon-ai/doompi`, not to a package in `packages/clients`. One process owns a `HeadlessHub`, an authenticated loopback HTTP and WebSocket listener, zero or more admitted workspaces, and zero or more sessions. The optional initial session and sessions opened later each receive an independent `HeadlessSessionHost` and `DirectHarnessRuntime`.

Startup loads the synchronized global server bundle first. Workspace admission validates that repository's registration and mounts its workspace-scoped facets. Session creation loads the selected session candidates, creates a SQLite-backed direct harness runtime, installs the session facets, and publishes that session's web composition. Global, workspace, and session facets have separate Cordis roots and disposal lifetimes.

The `/api/pi` WebSocket carries the client-neutral protocol used by the browser and desktop clients. The protocol exposes hub and session management, replicated session state, prompt and steering operations, queue management, model and thinking changes, compaction, rewind, extension UI responses, statistics, and package API forwarding. Control routes require the attach token. Remote access is a separate authenticated boundary that forwards into the loopback listener.

The web presentation server resolves package-owned browser assets and plugin compositions but does not own agent execution. For each scope it uses the web composition published by the headless runtime. Session package APIs execute beside their session host; workspace and global APIs execute in their own admitted host scopes.

SQLite session storage is the durable transcript source. Protocol state and bounded presentation projections support live clients and reconnect, but they are not a second durable event log.

Configuration, registration, and descriptor failures fail closed. The server does not select an alternate generation when `server.bundle.json` is missing, malformed, stale, or mismatched. `doompi sync --check` is read-only: it re-resolves configuration and package paths, compares the active fingerprint, and validates the registration and generated artifacts. Use `doompi sync --global --check` for the shared global registration.

## Runtime services and lifecycle

Interactive Pi and headless sessions use different execution hosts but the same ownership rule: every contribution belongs to an explicit lifecycle.

In an interactive Pi runner, `cordisHost` creates the application root. Independently loaded factories discover it through the versioned `doom:cordis:host:v1:query` EventBus contract. The runtime fiber publishes long-lived services, and the session fiber is replaced on each `session_start`. `cordisFinalizer`, the last factory, shuts down the root after package shutdown handlers run.

A server scope is installed into its own Cordis root by `installServerFacets()`. The root publishes `doom/server-host`; session roots also receive `doom/headless-host`. Facets declare dependencies on their object plugin, register APIs, channels, typed methods, services, and headless contributions through the host, and unwind those registrations with their owning fiber.

Each `HeadlessSessionHost` owns one Doom kernel. The kernel computes active tools, commands, resources, hooks, restrictions, and activities from the admitted facet candidates. Selection application is serialized, dispatch remains blocked until the complete selection is ready, and stale or failed changes cannot expose a partially applied tool surface.

Package services use namespaced `doom/*` keys. Neutral service types and serialization contracts live in `@agimon-ai/doompi-core`; provider implementations remain package-private. Required consumers declare Cordis `inject` dependencies. Providers publish services and effects from the package fiber that owns their lifetime.

Only state that must cross Pi module replacement may use `Symbol.for` storage. Those handoffs are generation-fenced and time-limited. Live collaboration within one host stays in its Cordis tree. Cleanup must be idempotent because shutdown, replacement, and failed startup can race.

## Selection and transitions

A selection is the requested major mode, domains, minor modes, profile, and package-owned state. A synchronized generation contains the artifacts needed to realize valid selections without importing code from another generation.

Interactive Pi sessions classify structural changes before applying them:

| Disposition     | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `live`          | Apply without structural replacement, or accept an unchanged composition.     |
| `reload`        | Replace session resources or factories through Pi `ctx.reload()`.             |
| `relaunch`      | Requires a new launcher process because the parent extension closure changed. |
| `sync-required` | Resolution or the fingerprint-addressed synchronized artifact is unavailable. |

The Pi transition coordinator serializes structural requests and fences them by session, host generation, config generation, and operation ID. Reload is terminal for the calling handler. After `await ctx.reload()`, code must not use a captured Pi context.

Headless sessions do not reload Pi factories. Their server bundle retains the session facet candidates for the admitted generation, and the session kernel changes which package contributions are active. Selection changes are serialized, revalidated, and published only after every affected kernel sink refreshes. A missing required facet or stale synchronized bundle blocks dispatch or requires resynchronization instead of falling back.

## Child session isolation

Interactive detached children use the resolver's dedicated child activation list and start their own Pi runner and Cordis root. Headless child sessions use a separate direct harness runtime and session storage owned by the parent session's child service. Neither form inherits a parent's mutable service instances or session registries.

Data crossing a child boundary uses explicit request, projection, and intercom contracts. Parent and child identities, transcript ownership, and cleanup remain separate even when a headless child executes in the same process.

## Contributor contract

A standard feature declares one or more direct entries: `definePiExtension` for interactive Pi, `defineServerPlugin` for headless server scopes, and `defineWebPlugin` for presentation. A package advertises its built server facet and explicit `global`, `workspace`, or `session` scopes through `package.json` `doompiServer`. Packages with public typed methods also publish their generated API-contract entry there.

Pi and server helpers own Cordis initialization, registration, readiness, rollback, and disposal. Server facets must use the object plugin form so their dependencies and completion belong to one observable fiber. Typed per-scope factories may be async. Optional `onStart`, `onStop`, and `onDispose` hooks cover external work and final resources.

Headless tools, commands, resources, hooks, restrictions, and activities register through the session host and are activated by the kernel. Dynamic Pi catalogs continue to use typed `snapshot()` and `subscribe(listener)` collections. Importing a public contract must not activate its provider.

Reusable public APIs live in flat `src/exports` forwarding files. Tsdown builds those, direct extension entries, server facets, and API-contract entries separately. Services own logic and IO, models own mutable state, controllers own request handling, and tools consume services or models. Shared schemas, types, and constants remain in their named folders. Do not add adapters, containers, commands, or providers roots.

The DoomPi package bootstrap is interactive host infrastructure. It claims a synchronized load before awaiting and stays inert outside a synchronized repository. Headless startup instead enters through the server builder and admits only validated synchronized server bundles.

The following system invariants apply across packages:

- Load configured feature packages through standard Pi manifests.
- Declare dependencies on packages whose public contracts you consume. Voice owns its shared contracts, so consumers install its runtime dependency closure even when Voice is not selected.
- Activate feature plugins through the configured composition. Importing a shared contract must not activate its provider.
- Keep Runner RMUX binaries in artifact-only target packages.
- Put neutral cross-package contracts in `@agimon-ai/doompi-core` and concrete implementations in provider packages.
- Preserve authored order and occurrence provenance, then deduplicate activation only by canonical path.
- Use the single composition fingerprint at every runtime boundary.
- Let Pi own factory reload and module replacement.
- Keep transition planning pure and classify before persisting selection.
- Keep cross-reload globals generation-fenced and time-limited.
- Reject unknown or unusable synchronized state rather than guessing.

## Validation and implementation map

`pnpm lint:vibe --preflight-only` builds the repository-owned Doom plugins, then checks architectural lifecycle, package-boundary, and prompt-resource rules according to each package's configured severity. `pnpm nx run @agimon-ai/doompi:test-system` exercises installed packed entries and runtime modes.

| Responsibility             | Entry points                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| Canonical composition      | [`extensionAssembler.ts`](../packages/core/doompi/src/builders/cli/extensionAssembler/index.ts)           |
| Interactive launcher       | [`launchPlan.ts`](../packages/core/doompi/src/builders/cli/launchPlan/index.ts)                           |
| Interactive runtime bundle | [`runtimeBundle.ts`](../packages/core/doompi/src/builders/cli/runtimeBundle/index.ts)                     |
| Synchronized state         | [`syncState.ts`](../packages/core/doompi/src/composition/syncState/index.ts)                              |
| Artifact validation        | [`bootstrapLocator.ts`](../packages/core/doompi/src/builders/cli/bootstrapLocator/index.ts)               |
| Package bootstrap          | [`pi.ts`](../packages/core/doompi/src/extensions/pi.ts)                                                   |
| Server runtime             | [`runtime.ts`](../packages/core/doompi/src/builders/server/runtime.ts)                                    |
| Server bundle build        | [`server/index.ts`](../packages/core/doompi/src/builders/server/index.ts)                                 |
| Server facet lifecycle     | [`serverFacetLoader.ts`](../packages/core/doompi-core/src/server/serverFacetLoader.ts)                    |
| Headless session host      | [`headlessSessionHost.ts`](../packages/core/doompi-core/src/systems/main/adapters/headlessSessionHost.ts) |
| Headless kernel            | [`kernel/index.ts`](../packages/core/doompi-core/src/services/kernel/index.ts)                            |
| Client-neutral protocol    | [`headlessServer.ts`](../packages/core/doompi-core/src/server/headlessServer.ts)                          |
| Package API hosting        | [`packageApiServer.ts`](../packages/core/doompi-core/src/server/packageApiServer.ts)                      |
| Transition classification  | [`transitionClassifier.ts`](../packages/core/doompi-core/src/services/transitionClassifier/index.ts)      |
| Pi transition entry        | [`transitionCoordinator.ts`](../packages/core/doompi/src/extensions/transitionCoordinator.ts)             |
| Cordis host lifecycle      | [`cordisHost.ts`](../packages/core/doompi-core/src/pi/cordisHost.ts)                                      |
