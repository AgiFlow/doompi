# DoomPi Desktop

DoomPi Desktop packages the DoomPi cockpit as an Electron application. It starts the client-neutral `doompi-server` process and the presentation-only `doompi-web` proxy, then loads the proxy in the native window. Electron owns application startup, the native window, and desktop-only host integration.

The package is workspace-private. It produces macOS arm64 and Linux x64/arm64 release artifacts rather than a published npm library.

## Run from the workspace

From the repository root:

```bash
pnpm install
pnpm cockpit:build
pnpm --filter @agimon-ai/doompi-desktop start
```

Desktop starts both local loopback processes, waits for the headless health endpoint and the web proxy health endpoint, then loads the proxy HTTP origin. It prefers port `7433` for the proxy and `7434` for the headless protocol, selecting free ports when either default is unavailable.

For development, tests, and release packaging, see [Getting started](./docs/getting-started.md).

## Architecture

```text
Electron main process
  ├─ BrowserWindow + minimal preload API
  ├─ doompi-server
  │    └─ headless session and agent runtime
  └─ doompi-web
       ├─ serves browser assets
       └─ proxies the headless HTTP and WebSocket protocol
```

The application stages the web client, headless server, DoomPi runtime, native helpers, and package resources into a release runtime. Both child processes run with Electron's executable in Node mode, so the release does not carry another Node executable.

Read [Architecture](./docs/architecture.md) for process ownership and lifecycle details. Read [Runtime and packaging](./docs/runtime-and-packaging.md) for the staged runtime, signing, and artifact model.

## Security boundary

The renderer is sandboxed, has no Node integration, and receives only the desktop platform marker and application version through preload. Navigation remains on the web proxy origin, while approved external HTTPS links open in the system browser.

These controls reduce renderer privilege. They do not sandbox the headless server, proxy, or agents. Those processes run with the user's operating-system authority, and other local processes can reach the loopback listeners. Remote access inherits the web proxy's authentication and transport model.

Read [Security](./docs/security.md) for the complete boundary and its limitations.

## License

Source is available under the [DoomPi Desktop License](./LICENSE). Use is free for production and commercial purposes, but redistribution and offering the software as a hosted or managed service are not permitted.
