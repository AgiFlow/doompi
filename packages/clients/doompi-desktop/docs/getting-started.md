# Getting started with DoomPi Desktop

DoomPi Desktop is built from the monorepo. This package is private and does not expose a library API or a standalone npm installation path.

## Prerequisites

Use the repository-pinned toolchain:

- Node.js `22.22.1`
- pnpm `11.1.3`

Install the workspace dependencies from the repository root:

```bash
pnpm install
```

## Run the application

Build the cockpit and start Electron:

```bash
pnpm cockpit:build
pnpm --filter @agimon-ai/doompi-desktop start
```

`start` builds the Electron main and preload entries, stages the desktop runtime, and launches the generated main entry. It does not provide hot reload. Stop the application normally or interrupt the command.

The desktop selects a loopback cockpit port automatically. To move session discovery to another directory, set `DOOMPI_RUNTIME_DIR` before starting:

```bash
DOOMPI_RUNTIME_DIR=/tmp/doompi-run \
  pnpm --filter @agimon-ai/doompi-desktop start
```

The main process removes inherited `DOOMPI_*` variables before starting the packaged cockpit, then supplies its own runtime paths, port, desktop marker, and agent command. `DOOMPI_RUNTIME_DIR` is the explicit exception carried into that environment.

Keep the registry path short. Desktop requires at least 40 bytes of path budget after the registry directory for a session socket. It rejects a path that cannot meet that bound before the cockpit starts, avoiding a later Unix-socket failure with a less useful error.

## Run focused checks

From the repository root:

```bash
pnpm nx run @agimon-ai/doompi-desktop:lint
pnpm nx run @agimon-ai/doompi-desktop:typecheck
pnpm nx run @agimon-ai/doompi-desktop:build
pnpm nx run @agimon-ai/doompi-desktop:test
pnpm nx run @agimon-ai/doompi-desktop:test:e2e
```

The unit target covers process launch, window restrictions, runtime staging, and native host policy. The end-to-end target launches the generated Electron entry against a fixture cockpit and verifies the application shell.

## Build a release artifact

Run the package target through Nx so its dependency builds execute:

```bash
pnpm nx run @agimon-ai/doompi-desktop:package
```

Release artifacts are written under `packages/clients/doompi-desktop/release`. Current targets are:

- macOS arm64 DMG and ZIP
- Linux x64 AppImage and DEB
- Linux arm64 AppImage and DEB

Packaging is not a portable cross-platform build. Build each target on the corresponding operating system and architecture, especially macOS where nested executable signing and Apple notarization are part of the release path.

For artifact structure, signing inputs, and the absence of an in-app updater, read [Runtime and packaging](./runtime-and-packaging.md).

## Troubleshooting

### The cockpit never becomes ready

The application waits for the staged hub's `/api/health` endpoint. Check the terminal output for the cockpit child failure. Common causes are an incomplete runtime stage, a missing packaged entry or native binary, a sync or initialization error, or another process taking the selected port before the child binds it.

### Port 7433 is already in use

This is normally harmless. Desktop selects a free ephemeral port when its preferred port is occupied.

### Desktop and CLI show different sessions

Confirm both processes use the same `DOOMPI_RUNTIME_DIR`. With no override, both use `~/.doompi/run`.

### Computer use reports unavailable

Computer use requires an arm64 Mac running macOS 15 or newer, the packaged native helper, and manually granted Accessibility and Screen Recording permissions. Run the Computer Use Doctor action to inspect the capability probe without requesting permissions. If the helper or either permission is unavailable, target discovery and activation fail closed.

## Next steps

- [Understand the process topology](./architecture.md)
- [Inspect runtime and release assembly](./runtime-and-packaging.md)
- [Review authority and security limits](./security.md)
