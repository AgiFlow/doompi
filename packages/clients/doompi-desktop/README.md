# @agimon-ai/doompi-desktop

The DoomPi desktop app. It bundles the cockpit and the session server so a
download runs an agent on a machine with no Node, no pnpm, and no checkout.

Private to this workspace: it ships as a GitHub Release artifact, not to npm.

## How it works

The app is a thin shell around the cockpit that already exists.

```
Electron main
  |- spawns the staged cockpit with ELECTRON_RUN_AS_NODE=1
  |    |- spawns doompi-server per session
  |         |- spawns the agent
  '- BrowserWindow -> http://127.0.0.1:7433
```

Three decisions carry most of the weight.

**The runtime is this app's own binary.** Electron is Node when `ELECTRON_RUN_AS_NODE`
is set, and the variable is inherited, so one assignment on the cockpit's
environment reaches the session server and the agent below it. No second Node
ships, and no code in `doompi-web`, `doompi-server` or `doompi` core knows it is
running inside a desktop app.

**The window loads loopback HTTP, not bundled files.** The cockpit builds every
socket URL from `location`, so a `file://` or custom-scheme origin would break
its transport, and the service worker would not register. `http://127.0.0.1` is
a trustworthy origin to Chromium, so everything keeps working unchanged, and the
same bundle is still served to a remote paired browser.

**The runtime is a build artifact, not a deployed package tree.** Vite bundles
the cockpit, server, agent, and workspace JavaScript into `build/runtime`. Its
runtime plugin copies the built web assets, RMUX and RTK payloads, platform-native
addons, and the scoped browser package graph needed to compose user plugins. It
never walks or ships the general workspace `node_modules` tree.

## Layout

| Path                              | Purpose                                              |
| --------------------------------- | ---------------------------------------------------- |
| `src/bin/main.ts`                 | Electron entry: lifecycle, single-instance lock, IPC |
| `src/bin/preload.ts`              | The whole renderer bridge, deliberately two members  |
| `src/adapters/hubProcess.ts`      | Starts, health-checks and stops the cockpit          |
| `src/adapters/mainWindow.ts`      | Window creation and navigation confinement           |
| `src/services/hubLaunch.ts`       | Pure path, environment and socket-budget logic       |
| `vite.runtime.config.ts`          | Bundles the child-process runtime artifact           |
| `scripts/desktopRuntimePlugin.ts` | Copies composition assets and native payloads        |
| `scripts/signHubBinaries.cjs`     | Signs native binaries before the app is signed       |

## Commands

```bash
pnpm nx run @agimon-ai/doompi-desktop:build     # compile main and preload
pnpm --filter @agimon-ai/doompi-desktop build:runtime # bundle the child runtime
pnpm --filter @agimon-ai/doompi-desktop start   # build the artifact and run locally
pnpm nx run @agimon-ai/doompi-desktop:package   # produce installers
pnpm --filter @agimon-ai/doompi-desktop test
```

## State

The app shares `~/.doompi/run` with the CLI rather than using
`app.getPath('userData')`, so a session started here is visible to `doompi` in a
terminal and the other way round. `DOOMPI_RUNTIME_DIR` overrides it. Startup
measures the resulting socket path against the 104-byte `sun_path` cap and
refuses early rather than failing later, when the user starts a session.

## Signing

macOS builds are Developer ID signed and notarized in CI from
`APPLE_CERTIFICATE_P12_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID`. Without an identity, electron-builder still produces unsigned
artifacts, so local builds work with no credentials. Linux ships unsigned.
