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

### Build locally, then upload a versioned draft

Run on an Apple Silicon Mac with macOS 15 or newer. Select the Desktop package version in `packages/clients/doompi-desktop/package.json` and commit it before building. Desktop versions are independent of the npm release groups. Use a clean checkout and an artifact directory outside it that does not already exist.

Install a Developer ID Application certificate with its private key. `security find-identity -v -p codesigning` must list the exact `CSC_NAME`. Keep all credentials outside repository files and logs.

```bash
export CSC_NAME='Developer ID Application: Your Company (TEAMID1234)'
export APPLE_TEAM_ID='TEAMID1234'
export NOTARYTOOL_KEYCHAIN_PROFILE='DoomPiNotary'
# Enter your Apple ID and app-specific password at the prompts, not in shell history.
xcrun notarytool store-credentials "$NOTARYTOOL_KEYCHAIN_PROFILE" --team-id "$APPLE_TEAM_ID"
pnpm build:desktop:macos --out "$HOME/Desktop/doompi-artifacts"
```

The build requires Node, pnpm, Swift/Xcode tools and validated Apple credentials, but no GitHub authentication. It builds macOS arm64 DMG and ZIP, completes signing/notarization/stapling, verifies both enclosed applications, and then writes SHA-256 checksums and `desktop-build.json`. The signed plist records the full version and source commit. Output is preserved after failures and never silently replaced.

Before uploading, install **both final artifacts** on a clean Mac without Node, pnpm or the workspace. Verify first-run startup, computer-use permissions/actions, local and remote approval/revocation, recording playback/download, and child cleanup on quit. Test the exact checksummed bytes. Rebuilding requires repeated acceptance. The automated staged-runtime test supplements, but does not replace, this signed-app smoke test.

After the build commit is pushed to `AgiFlow/doompi`:

```bash
gh auth login --hostname github.com
pnpm release:desktop --from "$HOME/Desktop/doompi-artifacts"
```

Upload requires `gh` push access and local macOS verification tools, but no signing private key or Apple credentials. It verifies file confinement, hashes, signatures/notarization, embedded version/commit and the Desktop manifest at the recorded GitHub commit. It never rebuilds, re-signs, repacks or bumps versions.

The script creates `desktop-v<version>` at the built commit and uploads DMG, ZIP, checksums and build manifest to a **GitHub draft**. Prerelease status follows the version. It never moves a tag, overwrites assets, publishes npm packages, publishes automatically or marks a release latest. The manual CI package-check workflow still does not publish.

GitHub writes are not transactional. After an interrupted upload, keep the original artifact directory and rerun `release:desktop --from` to upload only missing assets into the matching draft. Existing assets must match their hashes. Conflicting tags, unexpected assets, a different build manifest or an already published release are refused. Do not publish while an upload is in progress. Review the complete draft and publish it manually only after acceptance passes.

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
