# DoomPi architecture

[Back to DoomPi](../README.md)

DoomPi resolves configuration into an ordered set of standard Pi extension factories. Pi owns the extension runner, registration API, reload, and module replacement. DoomPi owns configuration resolution, composed factory loading, runtime artifacts, composition identity, and transition coordination.

This document defines the current boundaries and contributor invariants.

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

The shared hub pins web assets and package APIs to its startup repository. Session API requests resolve through the session `cwd`, so concurrent sessions can use different repositories without changing the hub registration. Outside a synchronized repository, the server uses packaged web assets and inherits the package APIs of the installation running it, so a session in an unsynchronized checkout still mounts the cockpit's own APIs instead of none. Explicit `--assets`, `DOOMPI_WEB_DIST`, and `DOOMPI_API_DIR` overrides retain precedence.

Configuration drift and missing synchronization are diagnosed separately. `doompi sync --check` is read-only: it re-resolves configuration and package paths, compares the active fingerprint, and validates the registration, bootstrap, and full bundle map.

## Runtime services and lifecycle

Each Pi extension runner owns one Cordis application root. `cordisHost`, the first factory, creates it. Independently loaded factories discover that host through the versioned `doom:cordis:host:v1:query` EventBus contract and validate the returned root with `Context.is()`.

The host owns two lifecycle levels:

- The runtime fiber publishes `doom/runtime` and `doom/tool-overrides` for the lifetime of the runner.
- A session fiber is replaced on each `session_start` and publishes `doom/session` and `doom/context-contributions` for that session.

Package services use namespaced `doom/*` keys. Neutral service types and serialization contracts live in `@agimon-ai/doompi-extension-contracts`; provider implementations are package-private. Required consumers declare their dependency with Cordis `inject`. It activates a consumer only while its provider exists and reactivates the consumer when the provider is replaced. Providers publish services and effects from the package plugin fiber that owns their lifetime.

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

Core composition produces a dedicated child activation list. A detached child starts its own Pi runner with its own host, required child core, selected feature and selection-specific entries, and finalizer.

The child does not inherit the parent Cordis root, transition coordinator, live service instances, or mutable session registries. Data that crosses the process boundary is an explicit serialized projection owned by the launching feature. Parent and child activation lists share the same resolver interpretation and participate in the same composition fingerprint.

## Contributor contract

A standard feature factory should:

1. connect through `connectDoomCordisHost()`;
2. mount one package adapter with `root.plugin()`;
3. register Pi-facing wrappers through the supplied `ExtensionAPI`;
4. publish services from the package plugin context and consume hard dependencies under `inject`;
5. place independent heavy work behind a readiness handle;
6. make cleanup idempotent; and
7. dispose the package fiber before releasing the host connection.

The following system invariants apply across packages:

- Load configured feature packages through standard Pi manifests.
- Keep fixed host packages independent of selectable packages.
- Keep selectable packages independent at install and import time. Runner RMUX payload packages are the packaging exception.
- Put neutral cross-package contracts in `@agimon-ai/doompi-extension-contracts` and concrete implementations in provider packages.
- Preserve authored order and occurrence provenance, then deduplicate activation only by canonical path.
- Use the single composition fingerprint at every runtime boundary.
- Let Pi own factory reload and module replacement.
- Keep transition planning pure and classify before persisting selection.
- Keep cross-reload globals generation-fenced and time-limited.
- Reject unknown or unusable synchronized state rather than guessing.

## Validation and implementation map

`pnpm lint:vibe --preflight-only` builds the repository-owned Doom extension plugin, then checks architectural lifecycle, package-boundary, and prompt-resource rules according to each package's configured severity. `pnpm nx run @agimon-ai/doompi:test-system` exercises installed packed entries and runtime modes.

| Responsibility            | Entry points                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Composition               | [`extensionAssembler.ts`](../packages/core/doompi/src/services/extensionAssembler.ts)                 |
| Launcher bundle           | [`runtimeBundle.ts`](../packages/core/doompi/src/adapters/runtimeBundle.ts)                           |
| Synchronized state        | [`syncState.ts`](../packages/core/doompi/src/adapters/syncState.ts)                                   |
| Synchronized bundle build | [`syncedRuntimeBuilder.ts`](../packages/core/doompi/src/adapters/syncedRuntimeBuilder.ts)             |
| Artifact validation       | [`bootstrapLocator.ts`](../packages/core/doompi/src/adapters/bootstrapLocator.ts)                     |
| Package bootstrap         | [`packageBootstrap.ts`](../packages/core/doompi/src/adapters/packageBootstrap.ts)                     |
| Transition classification | [`transitionClassifier.ts`](../packages/core/doompi/src/services/transitionClassifier.ts)             |
| Transition serialization  | [`transitionCoordinator.ts`](../packages/core/doompi/src/services/transitionCoordinator.ts)           |
| Pi transition adapter     | [`transitionCoordinator.ts`](../packages/core/doompi/src/extensions/entries/transitionCoordinator.ts) |
| Cordis host lifecycle     | [`cordisHost.ts`](../packages/core/doompi-extension-contracts/src/adapters/pi/cordisHost.ts)          |
| Config readiness barrier  | [`configExtension.ts`](../packages/core/doompi-config/src/adapters/pi/configExtension.ts)             |
