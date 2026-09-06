# Composition and runtime bundling

[Back to DoomPi](../README.md)

DoomPi does two separate jobs before Pi opens its TUI:

1. **Composition** decides which extension factories belong in the session and in what order.
2. **Bundling** turns that resolved plan into JavaScript Pi can load.

The composition is the contract. A bundle is one way to deliver it. If launcher bundling is unavailable, DoomPi can still give Pi the same ordered extension entries individually.

## From configuration to a composition

DoomPi reads the home configuration first and the nearest repository configuration second. The active profile, major mode, domains, and minor modes supply runtime selections. `modes.yaml` supplies the default packages, named layers, and the layer order for each major mode.

The resolver converts those inputs into one canonical plan:

```text
home and repository configuration
               +
       current selections
               |
               v
 resolveExtensionComposition()
       |                 |
       |                 +-- detached-child factories
       +-- TUI factories
               |
               +-- composition fingerprint
```

The TUI factory list begins with the Cordis host and ends with its finalizer. Fixed host factories load first, followed by configured defaults and the selected layers in canonical order. When the same resolved extension appears more than once, DoomPi keeps every authored occurrence for diagnostics but activates the factory once, at its first position.

The resolver also produces a SHA-256 fingerprint. It covers the parent and detached-child activation plans, so it changes when the executable composition changes. DoomPi uses that fingerprint to name bundles, detect stale synchronized state, and decide whether a selection can update live or needs a reload or relaunch.

## The launcher path

Running `doompi` or `dpi` resolves the active composition and provisions the packages it needs. The launcher then tries to flatten the ordered extension factories into one aggregate runtime bundle.

```text
active composition -> aggregate JavaScript bundle -> Pi extension runner -> TUI
```

This keeps Pi startup pointed at one generated entry and freezes the resolver's activation order. The aggregate file is not a different plugin system and does not change which skills, tools, prompts, or extensions load. If the compiler cannot create the aggregate bundle, the launcher falls back to the same canonical extension entries in order.

This path is useful for trying a composition immediately. It can compile as part of launch, so it is not the path used for a registered synchronized installation.

## The synchronized path

`doompi sync` prepares runtime state before the next TUI starts. It provisions the defaults and every declared named layer, resolves the possible compositions, and writes their bundles into one immutable generation under `~/.pi/.doom/sync`.

A generation contains more than TUI JavaScript:

- resolved state and composition fingerprints
- the bootstrap loaded by Pi
- runtime bundles for recorded compositions
- package resources
- web plugin artifacts and package API routes when available

The generated bootstrap does not compile extensions during startup. It reads the validated registration for the current repository or worktree, selects the bundle recorded for the active fingerprint, validates it, and imports it. If no recorded aggregate bundle is available, it can use the canonical entries stored for that composition.

This design has three practical reasons:

- **Predictable startup:** Pi loads already prepared files instead of discovering and compiling a graph while the TUI opens.
- **Repository isolation:** two repositories or Git worktrees can select different package sets without sharing mutable `current` state.
- **Safe publication:** readers see the old complete generation or the new complete generation, never half of each.

## Publishing a generation

Synchronization follows one transaction-like sequence:

1. Stage every artifact in a new generation directory.
2. Validate paths, manifests, source fingerprints, repository identity, and required files.
3. Atomically publish the registration that points readers at that generation.
4. Retain one previous generation and attempt to clean older ones.

Published generations are not edited in place. A cleanup failure is reported, but it does not invalidate the generation that was already published.

The registration is part of the boundary. It pins the repository identity, worktree, DoomPi package, Pi entry, state hash, and generation paths. A missing, stale, foreign, traversing, or malformed registration is rejected rather than replaced with a guessed source checkout or another repository's state.

## What happens when a selection changes

DoomPi resolves the candidate selection before applying it:

| Result                                           | TUI behavior                                          |
| ------------------------------------------------ | ----------------------------------------------------- |
| Same executable fingerprint                      | Update the live selection without replacing factories |
| Recorded compatible composition                  | Reload the prepared composition                       |
| Parent activation changed in a launcher session  | Relaunch Pi with the new plan                         |
| Required synchronized bundle is missing or stale | Stop the transition and ask for `doompi sync`         |

Domain and profile values can still change runtime data even when the extension factory set stays the same. The fingerprint answers whether executable composition changed, not whether every session value is identical.

## Why web bundling is separate

The runtime bundle above is Node.js code loaded by Pi. It is not the browser cockpit.

DoomPi Web starts from the same synchronized package composition, but it has different outputs and constraints: React and CSS need browser compilation, server channels must remain on the host, and one hub may serve sessions from different repositories. The web package therefore builds and serves its own per-session plugin compositions while keeping a stable package-owned shell.

See [DoomPi Web bundling](../packages/clients/doompi-web/docs/bundle.md) for that pipeline and the reasons behind its design.

## Checking synchronized state

Use the read-only check when startup says synchronized state is unavailable:

```bash
doompi sync --check
```

Run `doompi sync` to install missing required packages and publish a replacement generation. `dpi sync` builds the same repository-isolated state for the side-by-side runner without persisting a Pi settings overlay.

See [Configuration](configuration.md) for merge rules and [Architecture](architecture.md) for runtime ownership and transition coordination.
