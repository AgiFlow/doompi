# Desktop architecture

DoomPi Desktop turns the existing browser cockpit into a native application without creating a second control plane. Electron supplies process startup, a constrained renderer, application lifecycle, release packaging, and the native computer-use host. The client-neutral headless server owns sessions and agents. DoomPi Web only presents and proxies that server.

This split keeps browser and desktop behavior on the same protocol and session model. Desktop uses the same authenticated HTTP and WebSocket boundary as other clients, not a desktop-only transport.

## System topology

```text
Electron application
  │
  ├─ main process
  │    ├─ acquires the single-instance lock
  │    ├─ selects loopback ports
  │    ├─ starts and supervises the headless and web children
  │    └─ owns BrowserWindow and native IPC handlers
  │
  ├─ preload
  │    └─ exposes platform and app version only
  │
  └─ renderer
       └─ loads http://127.0.0.1:<web-port>

headless child: doompi-server
  ├─ owns the session and agent runtime
  └─ exposes the authenticated HTTP and WebSocket protocol

presentation child: doompi-web
  ├─ serves the web shell
  └─ proxies /api and /api/pi to doompi-server
```

The renderer loads a loopback HTTP origin instead of `file://`. The web client derives its protocol URLs from the page location and bootstraps through a service worker, both of which require an HTTP origin. The presentation proxy and headless process therefore use the same web contracts in a browser or inside Electron.

## Ownership boundaries

### Electron main process

The main process owns desktop-only concerns:

- one running desktop application instance
- loopback port selection
- headless and presentation child startup and shutdown
- health-gated window loading
- window bounds and navigation policy
- native application IPC handlers
- desktop computer-use host wiring

It does not resolve plugin composition, create additional sessions, or launch agents directly. Those operations stay in the headless server.

### Headless and presentation processes

The staged `@agimon-ai/doompi` CLI starts one direct headless session and exposes its client-neutral protocol. It owns session state, server facets, APIs, channels, authorization, history, and the agent runtime.

The staged `@agimon-ai/doompi-web` CLI serves browser assets and forwards HTTP and WebSocket requests to the headless endpoint. It does not own sessions or load server extensions.

Desktop creates an attach token in the Electron user-data directory for the lifetime of the child processes. The headless child reads the token file, and the web child forwards the token to the headless endpoint. Desktop removes the file after both children stop.

### Computer-use host

On supported macOS builds, Electron owns the native computer-use backend. Requests cross the child boundary through the typed versioned computer-use IPC protocol. Desktop attaches that bridge to the headless child, never to the presentation proxy. If the headless child does not expose the required IPC channel, startup fails explicitly instead of falling back to a Unix HTTP transport.

### Renderer and preload

The renderer is an unprivileged web client. Its preload surface contains two values:

- `platform: 'desktop'`
- `version()`

Node integration is disabled, context isolation and the Chromium sandbox are enabled, and the session partition is not persisted. Native capability must be implemented in the main process and exposed deliberately. It is not inherited by arbitrary renderer code.

## Startup lifecycle

1. Electron removes command-line `--inspect` flags and acquires a single-instance lock.
2. The main process selects loopback ports, preferring `7433` for the presentation proxy and `7434` for the headless protocol.
3. It creates a hidden window with constrained web preferences and loads the startup page.
4. It starts the staged `doompi-server` with `ELECTRON_RUN_AS_NODE=1`, a token file, and the headless protocol port.
5. It polls the headless `/api/health` endpoint until the server answers or the startup deadline expires.
6. It starts the staged `doompi-web` proxy with the headless URL and token.
7. It polls the web proxy `/api/health` endpoint, then replaces the startup page with the proxy origin.
8. Closing the window quits the application. The main process terminates the presentation child and then the headless child.

A failed startup stops every owned child, removes the attach token, closes the window, and surfaces an error dialog before exiting.

## Window and navigation model

The application starts with an in-memory loading page, then replaces it with the web proxy after both process health checks succeed. The window uses fixed initial and minimum dimensions. The application does not persist window bounds.

Main-frame navigation is restricted to the initial proxy origin. New windows are denied. HTTPS links to other origins are handed to the operating system browser only after URL parsing and protocol checks. Other schemes remain blocked.

This policy limits common renderer escape paths, but it does not make the served cockpit content harmless. The proxy, headless server, and renderer still form one application trust boundary.

## Why a shell instead of a fork

A separate desktop session implementation would duplicate lifecycle, authentication, plugin loading, and agent-launch behavior. Keeping session capabilities in the client-neutral headless process has three practical effects:

- browser and desktop clients use the same observable contracts
- fixes in session and agent orchestration apply to both surfaces
- the Electron layer stays small enough to audit as native glue

The tradeoff is a multi-process application. Diagnostics must consider Electron, the presentation proxy, the headless server, and the agent runtime separately.

## Related guides

- [Getting started](./getting-started.md)
- [Runtime and packaging](./runtime-and-packaging.md)
- [Security](./security.md)
- [Web architecture](../../doompi-web/docs/architecture.md)
