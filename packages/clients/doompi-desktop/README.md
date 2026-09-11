# DoomPi Desktop

DoomPi Desktop packages the DoomPi cockpit as an Electron application. It is a desktop shell over the same hub, session-server, web, and agent architecture used by the command-line cockpit. Electron owns application startup and the native window. It does not replace the hub or introduce a separate session model.

The package is workspace-private. It produces macOS arm64 and Linux x64/arm64 release artifacts rather than a published npm library.

## Run from the workspace

From the repository root:

```bash
pnpm install
pnpm cockpit:build
pnpm --filter @agimon-ai/doompi-desktop start
```

The desktop process starts a cockpit on loopback, waits for its health endpoint, and loads that HTTP origin in the application window. It prefers port `7433` and selects a free ephemeral port when that port is unavailable.

For development, tests, and release packaging, see [Getting started](./docs/getting-started.md).

## Architecture

```text
Electron main process
  ├─ BrowserWindow + minimal preload API
  └─ packaged cockpit process
       └─ hub
          └─ session server
             └─ agent process
```

The application stages the existing web client, server, DoomPi runtime, native helpers, and package resources into a release runtime. The cockpit child runs with Electron's executable in Node mode, so the release does not carry another Node executable.

Sessions use the normal DoomPi runtime directory, `~/.doompi/run` by default or `DOOMPI_RUNTIME_DIR` when configured. Desktop and command-line clients therefore discover the same session registry.

Read [Architecture](./docs/architecture.md) for process ownership and lifecycle details. Read [Runtime and packaging](./docs/runtime-and-packaging.md) for the staged runtime, signing, and artifact model.

## Security boundary

The renderer is sandboxed, has no Node integration, and receives only the desktop platform marker and application version through preload. Navigation remains on the cockpit origin, while approved external HTTPS links open in the system browser.

These controls reduce renderer privilege. They do not sandbox the cockpit or its agents. The local hub and agent processes run with the user's operating-system authority, and other local processes can reach the loopback service. Remote access inherits the web cockpit's authentication and transport model.

Read [Security](./docs/security.md) for the complete boundary and its limitations.

## License

Source is available under the [DoomPi Desktop License](./LICENSE). Use is free for production and commercial purposes, but redistribution and offering the software as a hosted or managed service are not permitted.
