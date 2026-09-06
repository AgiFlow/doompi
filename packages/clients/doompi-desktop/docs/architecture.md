# Desktop architecture

DoomPi Desktop turns the existing browser cockpit into a native application without creating a second control plane. Electron supplies process startup, a constrained renderer, application lifecycle, and release packaging. The cockpit continues to own HTTP serving, sessions, and agents.

This split keeps browser and desktop behavior on the same protocol and session model. It also means the desktop application inherits the cockpit's authority and operational limits rather than containing them.

## System topology

```text
Electron application
  │
  ├─ main process
  │    ├─ acquires the single-instance lock
  │    ├─ selects a loopback port
  │    ├─ starts and supervises the cockpit child
  │    └─ owns BrowserWindow and native IPC handlers
  │
  ├─ preload
  │    └─ exposes platform and app version only
  │
  └─ renderer
       └─ loads http://127.0.0.1:<port>

cockpit child
  └─ DoomPi Web hub
       ├─ serves the web shell
       ├─ watches session registry records
       └─ starts doompi-server processes
            ├─ publish their session records
            └─ start agent processes
```

The renderer loads a loopback HTTP origin instead of `file://`. The web client derives its socket URLs from the page location and bootstraps through a service worker, both of which require an HTTP origin in this design. The same web application and hub contracts can therefore run in a browser or inside Electron. The hub and session server do not need to know which client opened them.

## Ownership boundaries

### Electron main process

The main process owns desktop-only concerns:

- one running desktop application instance
- loopback port selection
- cockpit child startup and shutdown
- health-gated window loading
- window bounds and navigation policy
- native application IPC
- desktop computer-use host wiring

It does not resolve plugin composition, create DoomPi sessions, or launch agents directly. Those operations stay below the hub boundary.

### Cockpit and session processes

The staged `@agimon-ai/doompi-web` CLI remains the cockpit control plane. It serves the web client and launches the staged `@agimon-ai/doompi-server` command when the cockpit creates a session. Each session server owns its registry record and agent process.

Session discovery uses the normal DoomPi runtime directory:

```text
DOOMPI_RUNTIME_DIR, when set
~/.doompi/run, otherwise
```

Electron's user-data directory is not a second session registry. Desktop and command-line tooling can observe the same session records.

### Renderer and preload

The renderer is an unprivileged web client. Its preload surface contains two values:

- `platform: 'desktop'`
- `version()`

Node integration is disabled, context isolation and the Chromium sandbox are enabled, and the session partition is not persisted. Native capability must be implemented in the main process and exposed deliberately. It is not inherited by arbitrary renderer code.

## Startup lifecycle

1. Electron removes command-line `--inspect` flags and acquires a single-instance lock.
2. The main process resolves the packaged runtime and chooses a loopback port. It prefers `7433` when that port is bindable, otherwise it asks the operating system for a free port.
3. It creates a hidden window with the constrained web preferences and loads the startup page.
4. It starts the staged cockpit CLI with `ELECTRON_RUN_AS_NODE=1` and a desktop-specific environment.
5. It polls `/api/health` until the cockpit answers or the startup deadline expires.
6. Electron shows the window when the startup page is ready, then replaces that page with the cockpit after the health check succeeds.
7. Closing the window quits the application. The main process terminates the cockpit child it started.

If a healthy cockpit appears on the selected port between selection and launch, startup can attach to it. In that case Electron does not own that process and does not stop it on exit. This is a race-safe fallback, not general discovery of an already occupied default port.

A failed startup stops an owned child, closes the window, and surfaces an error dialog before exiting.

## Window and navigation model

The application starts with an in-memory loading page, then replaces it with the loopback cockpit after the health check succeeds. The window uses fixed initial and minimum dimensions. The application does not persist window bounds.

Main-frame navigation is restricted to the initial cockpit origin. New windows are denied. HTTPS links to other origins are handed to the operating system browser only after URL parsing and protocol checks. Other schemes remain blocked.

This policy limits common renderer escape paths, but it does not make the served cockpit content harmless. The loopback server and the renderer still form one application trust boundary.

## Why a shell instead of a fork

A separate desktop session implementation would duplicate lifecycle, authentication, plugin loading, and agent-launch behavior. Keeping those capabilities in the hub has three practical effects:

- browser and desktop clients use the same observable contracts
- fixes in session and agent orchestration apply to both surfaces
- the Electron layer stays small enough to audit as native glue

The tradeoff is that desktop startup includes a local HTTP service and a process tree rather than a single renderer process. Diagnostics must consider Electron, the cockpit child, session servers, and agents separately.

## Related guides

- [Getting started](./getting-started.md)
- [Runtime and packaging](./runtime-and-packaging.md)
- [Security](./security.md)
- [Web architecture](../../doompi-web/docs/architecture.md)
- [Server lifecycle](../../doompi-server/docs/lifecycle.md)
