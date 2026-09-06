# Architecture

DoomPi Web separates the browser shell, the session hub, and the `doompi-server` processes that own agent sessions.

```text
Browser
  | one cockpit WebSocket
  v
DoomPi Web hub
  | one authenticated socket per registered session
  v
Session servers
  | Pi protocol and package APIs
  v
Agents and extensions
```

## Hub process

`doompi-web` owns the HTTP server, the browser WebSocket, the session registry watcher, and the remote-access state machine. It watches the registry at `~/.doompi/run` by default, or the directory selected by `--registry-dir` or `DOOMPI_RUNTIME_DIR`.

The hub reads each registry record's attach token file and connects to the named Unix socket. The token remains in the hub process. The browser does not perform the session handshake and an `attach` frame sent from the browser is refused.

One browser WebSocket carries hub events, session frames, channel frames, history requests, and commands for many sessions. Every session message includes its session ID. The hub keeps a bounded in-memory ring per session and replays available frames when a page subscribes again. A disconnected browser does not stop an agent.

## Session servers

Each `doompi-server` process owns one agent session and registers its socket, token file, working directory, and API socket. The hub may attach to an existing server or start one when the cockpit creates a session. Stopping the hub does not stop a server that it spawned.

A session server reads its package and extension composition when it starts. Rebuilding a synchronized composition does not change an already running process. Create a new session or restart the existing one after synchronization to load new session extensions and package API routes.

## Browser composition

The host shell is the packaged SPA. Web plugins are compiled into a separate composition and loaded for each session. The hub resolves that composition from the session's repository configuration root first, then the global configuration root. A registration is usable only when its web directory, plugin composition entry, plugin manifest, and API directory are present. The host never merges repository artifacts with global artifacts for one session.

The selected composition also determines the hub channel entries and the package API bundle associated with that session. The browser receives plugin metadata and signed asset URLs through the hub. See [bundle resolution](bundle.md) for generation and fallback rules.

## API boundaries

Package APIs are mounted by the hub under `/api/plugin/<basePath>`. A session-scoped API is served by the session server and reached through a hub proxy. A hub-scoped API runs in the hub process. The hub strips the package mount and routing selector before invoking a package handler.

The hub also owns built-in routes for health, sessions, files, settings, provider authentication, remote access, PWA bootstrap, and bundle assets. Session file routes are bounded to the session working directory. Repository settings use opaque repository IDs that the hub resolves, rather than trusting browser-supplied filesystem paths.

## Lifecycle

1. Startup ensures the global DoomPi configuration is initialized and attempts a global synchronization.
2. Existing registry records are read. Their configuration roots are synchronized on demand before attachment.
3. The hub attaches to discovered session servers and loads their selected web channels.
4. A browser connects to the hub and receives the session snapshot, channel list, and session frames.
5. A new session request synchronizes its working directory's configuration root before starting the server.
6. A restart synchronizes first, then replaces the session server while preserving the session identity where the server supports resume.
7. Closing the browser only removes that page's subscriptions. Closing the hub closes remote access, browser sockets, channels, and API handlers.

Only the global synchronization guard watches for later changes. A repository selected by `--dir` is synchronized on demand, not watched. A completed global sync reloads channels for sessions using the global composition without replacing the stable shell.

## Remote path

Remote access uses a second loopback listener. The tunnel listener is tagged separately from the local listener before the shared guard runs. Pairing and PWA bootstrap routes are served directly. Remote session sockets and protocol sockets require a paired device and a purpose-specific sealed channel. Other remote HTTP requests use the sealed gateway. See [remote security](security.md).
