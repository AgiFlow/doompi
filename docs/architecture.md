# DoomPi architecture

[Back to DoomPi](../README.md)

DoomPi adds composition and lifecycle policy around Pi without replacing Pi's runtime. Pi still owns extension registration, the runner, reload, and module replacement. DoomPi owns the decisions Pi should not have to infer: which factories belong together, how their services find one another, which prepared artifact matches a selection, and whether a change is live, reloadable, or requires another process.

The architecture follows four boundaries:

1. **One canonical composition:** launcher, synchronized startup, and detached children use the same resolver and fingerprint.
2. **Pi owns module execution:** DoomPi plans and coordinates; Pi performs factory loading and replacement.
3. **Cordis owns live collaboration:** packages publish versioned services instead of importing selectable implementations.
4. **Repository identity owns generated state:** synchronized artifacts are immutable and selected through a validated repository or worktree registration.

This guide explains those runtime boundaries and the contributor invariants they create. [Composition and runtime bundling](bundling.md) explains the artifact pipeline in reader-facing terms.

## System model

Both launcher and synchronized startup use the same composition resolver:

```text
resolved configuration and runtime selection
                    |
                    v
               host flags
                    |
                    v
      resolveExtensionComposition()
          |         |          |
          |         |          +-- one SHA-256 fingerprint
          |         +------------- detached-child activation
          +----------------------- parent activation
                    |
              +-----+-----+
              |           |
              v           v
       launcher bundle   synchronized state
              |           |
              |           +-- bootstrap and mode bundles
              |
              +-----+-----+
                    |
                    v
                Pi runner
```

A parent activation always begins with `cordisHost` and ends with `cordisFinalizer`. The resolver places fixed, default, layer, and selection-specific entries in canonical order. Default packages run before packages from the selected named layers.

The launcher may flatten the activation into one aggregate bundle before starting Pi. A synchronized session loads a generated bootstrap that selects either the recorded bundle or the canonical entries for the active composition. Both routes preserve the activation order returned by the resolver.

## Configuration and package boundaries

| Location             | Responsibility                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `packages/core/*`    | Runtime foundations and shared contracts. Only a defined subset is part of the fixed host. |
| `packages/default/*` | Default distribution features selected through configuration.                              |
| `packages/minor/*`   | Optional modes selected through configuration.                                             |
| `packages/clients/*` | Standalone client-facing processes, including the session server and browser cockpit.      |
| `layers/<layer>/*`   | Selectable higher-level extensions.                                                        |
| `packages/tooling/*` | Repository-owned development tools that are not part of the runtime package graph.         |

The published `@agimon-ai/doompi` package owns the host and its fixed core dependency set. Selectable packages remain outside that private dependency closure. This keeps the root host stable while allowing a repository to choose its distribution features.

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

`@agimon-ai/doompi-core` contains the kernel, reusable main and child systems, extension definitions, Pi integration, server APIs, and web capabilities. It is a dependency of other Doompi packages. Feature packages own their policy and feature services; `@agimon-ai/doompi-minor-mode` owns the mode catalog, commands, projection, and reload state.

`@agimon-ai/doompi` owns CLI commands and distribution composition. Its `src/builders/cli`, `src/builders/server`, and `src/builders/web` each own subsystem composition and bundling. The CLI builder constructs Pi extensions, the server builder wires the Hono server and session services, and the web builder generates and bundles browser state and plugin wiring. Shared compiler, input, and cache mechanics live in `src/compiler`. Shared selection data and persisted state live in `src/composition`. Command handlers, help, options, and presentation are collocated under `src/cli/commands/<name>`, including the sync workflow. Server arguments and process signals live in `src/cli/server`. Builders and composition cannot import CLI code; the compiler cannot import builders, composition, or CLI code. Public command classes remain compatibility delegates to function implementations.

## Canonical composition

`resolveExtensionComposition()` is the authority for the runtime graph. One call returns:

- the selected major mode and ordered layer occurrences;
- every authored package or extension occurrence, including provenance, authored configuration, and resolution outcome;
- the parent factory activation list;
- the detached-child factory activation list; and
- one deterministic composition fingerprint.

Authored occurrences remain visible even when the same package appears more than once. Factory activation is deduplicated separately by canonical resolved path, with the first authored occurrence winning. This preserves configuration provenance without activating the same module twice.

Parent and child activation lists are derived together and are both included in the single fingerprint. That fingerprint is the composition identity used by launcher planning, runtime bundles, synchronized state, persisted selection, drift detection, child projection, and transition classification.

## Runtime artifacts and synchronization

The `doompi` launcher provisions the defaults plus the active mode layers. It builds an aggregate runtime bundle from the canonical activation plan and falls back to the individual ordered entries if bundling is unavailable.

`doompi sync` provisions the defaults plus every declared named layer and stages one complete
immutable generation in the home-scoped repository/worktree namespace. State, bootstraps, mode
bundles, resources, web assets, and API routes all live beneath that generation.

Publication follows three steps:

1. Build and validate every artifact. Remove the unpublished generation if this fails.
2. Write the validated registration atomically, so readers select a complete generation.
3. Retain one superseded generation and attempt to remove older ones. Report cleanup failures
   without failing the published sync.

Published artifacts are not mutated in place.

Repository and worktree identities are the routing boundary. Consumers accept state only through the exact validated registration for the nearest repository. Registration validation confines paths to the generation, verifies the state hash and repository identity, and pins the DoomPi package root, version, manifest, and Pi entry that produced it. Missing, malformed, foreign, traversing, symlinked, stale, and unsupported registrations fail closed. Consumers do not fall back to another repository, a source checkout, an unregistered legacy state file, or a global `current` directory.

Synchronized state maps composition fingerprints to bundles and compiler manifests. The bootstrap has its own manifest. Manifest validation checks output confinement, artifact presence, source fingerprints, and the expected bootstrap entry. Immutable compiler artifacts may still be reused through the shared cache, but publication and runtime selection remain repository-isolated.

The package bootstrap is inert outside a synchronized repository. Inside one, it imports only the package and bootstrap pinned by the validated registration and never compiles during startup. When a selected composition has a recorded bundle, synchronized startup validates that bundle before importing it. An unusable registration, bootstrap, or recorded bundle reports:

```text
doompi could not read its synchronized state. Run doompi sync.
```

`doompi init` owns the global Pi dispatcher, user settings integration, and default theme.
`doompi sync` requires that integration for persisted mode but does not rewrite it. It reconciles
existing repository Pi settings and removes a legacy repository alias. `dpi` supplies its overlay
in memory and uses the same repository-isolated publication without requiring persisted settings.

The web hub serves the package-owned browser shell unless an explicit asset override is configured. For each session, it resolves a complete web generation from that session's repository, then uses the global generation as a web-only fallback. That selection keeps the client plugin composition, hub channels, and session-associated hub APIs together. A session selector connects to the canonical headless server's authenticated `/api/pi` WebSocket and typed session services. Session package APIs are dispatched in the headless server process from the admitted `server.bundle.json`; hub APIs use the web generation. There is no separate session transport or API-directory override.

## Canonical client-neutral headless server

`doompi-server` is the canonical process boundary for a headless session. It creates a `DirectHarnessRuntime`, installs server facets from the admitted `server.bundle.json`, and exposes an authenticated loopback HTTP and WebSocket listener. `/api/pi` carries the Pi 0.85 protocol for client-neutral consumers, including the browser cockpit, while the runtime remains in process.

The protocol publishes typed management, hub, and session services. Session operations include prompt, steer, follow-up, abort, queue management, model and thinking changes, compaction, rewind, extension UI responses, and typed state and statistics queries. The session state contains the authoritative transcript snapshot, transient progress, in-flight work, and bounded presentation projections.

The journal is the durable history source. Reconnect uses replicated state and a bounded in-memory presentation window with dropped-event reporting, not a durable transport log. The listener defaults to loopback and requires a token for control routes. DoomPi Web provides the separate browser and remote-access security boundary.

Configuration and descriptor failures fail closed. The server does not select an alternate module directory or another runtime generation when the admitted `server.bundle.json` is missing, malformed, or mismatched.

Configuration drift and missing synchronization are diagnosed separately. `doompi sync --check` is read-only: it re-resolves configuration and package paths, compares the active fingerprint, and validates the registration, bootstrap, and full bundle map for the requested repository. Use `doompi sync --global --check` to validate the shared global registration. Repositories using different installed package versions do not validate that shared registration against their own package paths.

## Runtime services and lifecycle

Each Pi extension runner owns one Cordis application root. `cordisHost`, the first factory, creates it. Independently loaded factories discover that host through the versioned `doom:cordis:host:v1:query` EventBus contract and validate the returned root with `Context.is()`.

The host owns two lifecycle levels:

- The runtime fiber publishes `doom/runtime` and `doom/tool-overrides` for the lifetime of the runner.
- A session fiber is replaced on each `session_start` and publishes `doom/session` and `doom/context-contributions` for that session.

Package services use namespaced `doom/*` keys. Neutral service types and serialization contracts live in `@agimon-ai/doompi-core`; provider implementations are package-private. Required consumers declare their dependency with Cordis `inject`. It activates a consumer only while its provider exists and reactivates the consumer when the provider is replaced. Providers publish services and effects from the package plugin fiber that owns their lifetime.

The context-contribution broker orders provider snapshots and isolates provider failures. Providers are responsible for bounding and redacting their own text before returning it.

Config publishes the session-scoped `doom/readiness` coordinator before starting asynchronous configuration I/O, then its Pi `session_start` handler waits for the Config handle. This makes Config the startup barrier for handlers registered after it. Other packages should put independent heavy initialization behind package-and-generation readiness handles so only dependent capabilities wait for it.

Only state that must cross Pi module replacement may use `Symbol.for` storage. Those handoffs are generation-fenced and time-limited. Live collaboration within one runner stays in the Cordis tree.

Feature packages release their plugin fibers before releasing their host connections. Pi awaits their shutdown handlers in registration order. `cordisFinalizer`, the last factory, then shuts down the host and recursively disposes any remaining session and application fibers. Cleanup must be idempotent because shutdown and replacement can race.

## Selection and transitions

A selection is the requested major mode, domains, minor modes, and profile. A composition is the ordered parent and child factory graph produced from the selected major-mode layers and host flags.

| Disposition     | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `live`          | Apply without structural replacement, or accept an unchanged composition.     |
| `reload`        | Replace session resources or factories through Pi `ctx.reload()`.             |
| `relaunch`      | Requires a new launcher process because the parent extension closure changed. |
| `sync-required` | Resolution or the fingerprint-addressed synchronized artifact is unavailable. |

A major-mode candidate is resolved before classification. An equal fingerprint is `live`. In a synchronized session, an unavailable resolution or bundle is `sync-required`. A candidate whose fingerprint maps to an existing bundle is classified for reload; startup validation still rejects a stale bundle. In a launcher session, a changed parent activation requires relaunch, while a structurally compatible change reloads. Changed domain and profile values reload, unchanged requests are live, and minor-mode actions are live.

The transition coordinator serializes structural requests and fences them by session, host generation, config generation, and structural operation ID. It rechecks generation before and after asynchronous execution, so stale completion cannot mutate a replacement session.

Reload is terminal for the calling handler. After `await ctx.reload()`, code must not read or mutate a captured Pi context.

## Parent and detached-child isolation

The CLI builder produces a dedicated child activation list. A detached child starts its own Pi runner with its own host, required child core, selected feature and selection-specific entries, and finalizer.

The child does not inherit the parent Cordis root, transition coordinator, live service instances, or mutable session registries. Data that crosses the process boundary is an explicit serialized projection owned by the launching feature. Parent and child activation lists share the same resolver interpretation and participate in the same composition fingerprint.

## Contributor contract

A standard feature declares `definePiExtension`, `defineServerPlugin`, or `defineWebPlugin` at its direct `src/extensions` entry. The entry composes controllers and typed tools backed by services and models. Named declarations handle fixed contributions; typed per-mount factories construct dependencies and may be async.

Pi and server helpers own Cordis initialization, registration, readiness, rollback, and disposal. Optional `onStart`, `onStop`, and `onDispose` hooks cover external work and final instance resources. Shutdown aborts the instance signal, waits for startup, stops work, unregisters in reverse order, and disposes the instance. Keep provider plugins in named service folders and compose them through `services`; use owning injections and typed `require...` accessors for required providers.

Fixed tools and modes use arrays. Dynamic Pi catalogs use typed `snapshot()`/`subscribe(listener)` collections. A new tool declaration with the same name replaces the current implementation and aborts old invocations; removal makes the registered wrapper unavailable. Core helpers own tool subscriptions. The minor-mode package owns mode collections, subscriptions, owner attachment, and withdrawal through its Pi and server services.

Reusable public APIs live in flat `src/exports` forwarding files. Tsdown builds those and direct extension entries separately. Services own logic and IO, models own mutable state, controllers own request handling, and tools consume services/models. Shared schemas, types, and constants remain in their named folders. Do not add adapters, containers, commands, or providers roots.

The doompi package bootstrap is host infrastructure: it claims a synchronized load before awaiting and stays inert outside a synced repository. It must load the canonical host before normal feature helpers connect to that host.

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

`pnpm lint:vibe --preflight-only` builds the repository-owned Doom extension plugin, then checks architectural lifecycle, package-boundary, and prompt-resource rules according to each package's configured severity. `pnpm nx run @agimon-ai/doompi:test-system` exercises installed packed entries and runtime modes.

| Responsibility            | Entry points                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Composition               | [`extensionAssembler.ts`](../packages/core/doompi/src/builders/cli/extensionAssembler/index.ts)        |
| Launcher bundle           | [`runtimeBundle.ts`](../packages/core/doompi/src/builders/cli/runtimeBundle/index.ts)                  |
| Synchronized state        | [`syncState.ts`](../packages/core/doompi/src/composition/syncState/index.ts)                           |
| Synchronized bundle build | [`syncedRuntimeBuilder.ts`](../packages/core/doompi/src/builders/cli/index.ts)                         |
| Artifact validation       | [`bootstrapLocator.ts`](../packages/core/doompi/src/builders/cli/bootstrapLocator/index.ts)            |
| Package bootstrap         | [`pi.ts`](../packages/core/doompi/src/extensions/pi.ts)                                                |
| Transition classification | [`transitionClassifier.ts`](../packages/core/doompi-core/src/services/transitionClassifier/index.ts)   |
| Transition serialization  | [`transitionCoordinator.ts`](../packages/core/doompi-core/src/services/transitionCoordinator/index.ts) |
| Pi transition entry       | [`transitionCoordinator.ts`](../packages/core/doompi/src/extensions/transitionCoordinator.ts)          |
| Cordis host lifecycle     | [`cordisHost.ts`](../packages/core/doompi-core/src/pi/cordisHost.ts)                                   |
| Config readiness barrier  | [`pi.ts`](../packages/core/doompi-config/src/extensions/pi.ts)                                         |
