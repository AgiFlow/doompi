# Getting started

[Back to DoomPi](../README.md)

## Install

```bash
npm install -g @agimon-ai/doompi
```

The package pins and installs the upstream Pi version used by `dpi`.

The root package contains the fixed host foundation only. Feature packages are selected by
`.doom/modes.yaml` and installed into the consumer repository when they are first needed.

## Status and requirements

DoomPi is alpha software. Configuration and package boundaries may still change between alpha
releases.

- Node.js 22.19.0 or newer for the published package
- Node.js 22.22.1 or newer when contributing from this workspace
- macOS or Linux on arm64 or x64 for the bundled Runner backend
- Pi 0.84.3 and Pi TUI 0.84.3 for packages that declare them as peer requirements

## Try DoomPi without replacing your Pi setup

`dpi` is the comparison runner. Use it to try DoomPi beside your current `pi` customization
before registering anything in Pi's settings:

```bash
dpi init    # create missing .doom files in this repository
dpi sync    # install required packages and build synchronized DPI state
dpi         # run the pinned Pi version with DPI's in-memory settings overlay
pi          # run your existing Pi setup for comparison
```

`dpi init` creates `.doom/config.yaml`, `.doom/modes.yaml`, `.doom/domains.yaml`, and
`.doom/profiles.yaml` in the current repository. It preserves existing files unless you pass
`--force` and does not create or change `.pi/settings.json`.

`dpi sync` installs missing required feature packages, writes generated state, and refreshes the extension alias and theme. It does not persist DPI's settings overlay in either Pi settings file. Sync provisions every declared layer, so switching to a prepared mode does not depend on the root package's private dependencies.

### Sync storage and worktrees

DoomPi stores generated sync state under `~/.pi/.doom/sync`, outside the repository. Each
Git worktree gets isolated runtime state while immutable build artifacts may be shared.

`dpi` preserves Pi's normal global and repository settings, then applies DoomPi's extension
and theme settings in memory. It never writes those values to `.pi/settings.json`.

Run `doompi sync --check` to detect stale or legacy state. Run `doompi sync` to rebuild it
in the current home-scoped layout.

When you are comfortable with DoomPi and no longer need the side-by-side experiment, register
it for normal Pi:

```bash
doompi init    # seed ~/.pi/.doom and register the extension alias and theme
doompi sync    # build synchronized state and refresh Pi integration
pi             # start DoomPi through the regular Pi command
```

`doompi` remains available as an explicit harness when you want per-run matrix flags:

```bash
doompi --major-mode copilot --no-domains
doompi --major-mode minimal --no-domains
doompi --major-mode copilot --no-domains --explain
```
