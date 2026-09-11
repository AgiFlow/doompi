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

`start` builds the Electron main and preload entries, stages the desktop runtime, starts a headless `doompi-server`, starts the presentation-only `doompi-web` proxy, and launches the generated main entry. It does not provide hot reload. Stop the application normally or interrupt the command.

Desktop prefers loopback port `7433` for the web proxy and `7434` for the headless protocol. It selects free ports when either preferred port is unavailable. The Electron main process creates the short-lived attach token required by the two children and removes it during shutdown.

## Run focused checks

From the repository root:

```bash
pnpm nx run @agimon-ai/doompi-desktop:lint --skip-nx-cache
pnpm nx run @agimon-ai/doompi-desktop:typecheck --skip-nx-cache
pnpm nx run @agimon-ai/doompi-desktop:build --skip-nx-cache
pnpm nx run @agimon-ai/doompi-desktop:test --skip-nx-cache
pnpm nx run @agimon-ai/doompi-desktop:test:e2e --skip-nx-cache
```

The unit target covers child argument construction, process runtime selection, window restrictions, runtime staging, and native host policy. The end-to-end target launches the generated Electron entry against fixture headless and web children and verifies the application shell.

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

### The application never becomes ready

Desktop waits for the headless server and then the web proxy `/api/health` endpoint. Check terminal output for either child failure. Common causes are an incomplete runtime stage, a missing packaged entry or native binary, a sync or initialization error, or another process taking a selected port before the child binds it.

### Port 7433 or 7434 is already in use

This is normally harmless. Desktop selects a free ephemeral port when either preferred port is occupied.

### Computer use reports unavailable

Computer use requires an arm64 Mac running macOS 15 or newer, the packaged native helper, and manually granted Accessibility and Screen Recording permissions. The headless child must also expose the typed computer-use IPC boundary. Run the Computer Use Doctor action to inspect capability availability without requesting permissions. If the helper, either permission, or the child boundary is unavailable, target discovery and activation fail closed.

## Next steps

- [Understand the process topology](./architecture.md)
- [Inspect runtime and release assembly](./runtime-and-packaging.md)
- [Review authority and security limits](./security.md)
