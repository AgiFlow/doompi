# Getting started

[Back to DoomPi](../README.md)

DoomPi can run beside an existing Pi setup or become the extension configuration used by the regular `pi` command. Start with the side-by-side path. It gives you the same composition and synchronized runtime without changing Pi's persisted settings.

## What installation adds

```text
@agimon-ai/doompi
        |
        +-- pinned Pi used by dpi
        +-- fixed DoomPi host
        +-- configuration and sync commands

repository .doom files
        |
        +-- selectable feature packages installed when needed
```

The root package contains the fixed host foundation. Features named in `.doom/modes.yaml` remain separate packages and resolve from the consumer repository. This keeps the host stable while each repository chooses its own composition.

## Requirements

- Node.js 22.19.0 or newer for the published package
- Node.js 22.22.1 or newer when contributing from this workspace
- macOS or Linux on arm64 or x64 for the bundled Runner backend
- Pi 0.85.0 and Pi TUI 0.85.0 for packages that declare them as peer requirements

DoomPi is alpha software. Configuration and package boundaries may change between alpha releases.

## Install

```bash
npm install -g @agimon-ai/doompi
```

The package pins the Pi version used by `dpi`.

## Try it without replacing Pi

Run these commands inside a repository:

```bash
dpi init    # create missing repository .doom files
dpi sync    # install configured packages and publish synchronized state
dpi         # run pinned Pi with an in-memory DoomPi settings overlay
pi          # run your existing Pi setup for comparison
```

`dpi init` creates `.doom/config.yaml`, `.doom/modes.yaml`, `.doom/domains.yaml`, and `.doom/profiles.yaml`. It preserves existing files unless `--force` is present and does not change `.pi/settings.json`.

`dpi sync` resolves the repository composition, installs required feature packages, and publishes an immutable runtime generation. It provisions every declared layer so a prepared mode switch does not depend on the root package's private dependencies. See [Composition and runtime bundling](bundling.md) for the build and publication model.

`dpi` keeps Pi's existing global and repository settings, then applies the DoomPi extension and theme overlay in memory. It does not persist that overlay.

## Where synchronized state lives

Generated state lives under `~/.pi/.doom/sync`, outside the repository. Registrations are scoped by repository and Git worktree. Two worktrees can select different compositions without sharing mutable runtime state, while immutable compiler output may still be reused.

Check state without writing:

```bash
dpi sync --check
```

Run `dpi sync` again when the check reports drift.

## Register DoomPi with Pi

Once the comparison setup behaves as expected:

```bash
doompi init    # seed personal config and register the extension alias and theme
doompi sync    # publish synchronized state for the registered integration
pi             # start DoomPi through regular Pi
```

`doompi init` owns the personal configuration and Pi integration. `doompi sync` updates generated runtime state but does not rewrite that integration. After registration, use `doompi sync --check` and `doompi sync` instead of their `dpi` forms.

## Inspect a composition before launch

The explicit `doompi` harness accepts per-run selections:

```bash
doompi --major-mode copilot --no-domains
doompi --major-mode minimal --no-domains
doompi --major-mode copilot --no-domains --explain
```

`--explain` prints the resolved mode, domains, profile, plugins, skills, agents, MCP boundary, and estimated prompt cost. MCP schema inspection can start configured stdio servers. Add `--no-mcp` when inspection must not execute them.

Next, read [Concepts](concepts.md) for the selection model and [Configuration](configuration.md) for the four files and their merge rules.
