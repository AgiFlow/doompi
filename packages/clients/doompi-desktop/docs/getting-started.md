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

### Build and stage the rolling macOS nightly

The local release script is the default distribution path for the desktop app. It must run on an Apple Silicon Mac running macOS 15 or newer, because the native computer-use helper targets that platform:

```bash
export CSC_NAME='Developer ID Application: Your Company (TEAMID1234)'
export APPLE_ID='your-apple-id@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='use-an-app-specific-password'
export APPLE_TEAM_ID='TEAMID1234'
export NOTARYTOOL_KEYCHAIN_PROFILE='DoomPiNotary'
pnpm release:desktop
```

The script requires a clean checkout, an installed Developer ID Application certificate with its private key, authenticated `gh` access with push permission to `AgiFlow/doompi`, and a validated `notarytool` keychain profile. It builds only the macOS arm64 DMG and ZIP, verifies the signed apps inside both downloads, and preserves the generated files in a temporary directory. It never publishes npm packages.

Create the notarization profile once in your login keychain. Do not commit the password or put it in a repository file:

```bash
xcrun notarytool store-credentials DoomPiNotary \\
  --apple-id "$APPLE_ID" \\
  --team-id "$APPLE_TEAM_ID" \\
  --password "$APPLE_APP_SPECIFIC_PASSWORD"
gh auth login --hostname github.com
```

The Apple Developer account must have a Developer ID Application certificate. Open Keychain Access after creating or importing it and confirm that the certificate has its private key. `security find-identity -v -p codesigning` must list the exact value used in `CSC_NAME`.

A successful run refreshes the single rolling `desktop-nightly` GitHub prerelease as a **draft**. The script moves only that tag to the built commit, uploads generation-specific DMG, ZIP, and SHA-256 files, removes older assets from that release, and verifies the final inventory. It never publishes the release or marks it latest. Review the draft and publish it manually after installing both files on a clean Apple Silicon Mac. The CI package-check workflow is manual-only and never publishes a release.

If an already published nightly is refreshed, the script first returns it to draft. Downloads are therefore unavailable until you publish the refreshed draft again. GitHub mutations are not transactional: a failure after the tag or asset step can leave a partial draft. Keep the preserved temporary directory, stop other release writers, and rerun the script to repair the nightly. Do not manually publish while a replacement is in progress.

The downloaded DMG and ZIP should be smoke-tested on a Mac without Node.js, pnpm, or the workspace installed. Confirm DoomPi starts its local server and web proxy, the cockpit loads, and quitting the app cleans up both child processes.

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
