# Architecture

DoomPi Web is a hub, not a browser wrapper around one agent. It keeps agent processes independent of browser tabs, joins many session servers behind one cockpit, and resolves the UI that belongs to each session.

That shape solves three problems:

- a browser may disconnect without stopping the agent
- one cockpit may show sessions from different repositories
- session credentials and server modules must stay off the browser

## The system in one picture

```text
Browser shell
  | one cockpit WebSocket
  | session id on every session frame
  v
DoomPi Web hub
  | registry discovery
  | one authenticated Unix socket per session
  | hub channels and hub package APIs
  v
DoomPi session servers
  | one agent per server
  | Pi protocol and session package APIs
  v
Agents and extensions
```

The browser, hub, and session server have different lifetimes. Closing a page removes that page's subscriptions. It does not stop the hub, session server, or agent. Closing the hub disconnects browser clients and hub-owned services, but independently running session servers continue until their own agents exit.

## Ownership boundaries

| Component               | Owns                                                                                                                      | Does not own                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Browser shell           | Navigation, session focus, timeline, composer, plugin UI, verified asset activation                                       | Session attach tokens, agent processes, server modules |
| DoomPi Web hub          | HTTP and WebSocket listeners, registry watch, session attachments, browser fan-out, hub channels, hub APIs, remote access | Agent lifetime, session API implementation             |
| `doompi-server`         | One agent, session socket, Pi protocol socket, session APIs, registry record                                              | Browser tabs, remote device authentication             |
| Synchronized generation | Runtime state, web plugin artifacts, hub registry, API registries                                                         | Live processes or mutable session state                |

Keeping these responsibilities separate prevents a browser reconnect from becoming an agent restart and prevents a plugin client from receiving host credentials merely because its server half needs them.

## Session discovery and attachment

Each `doompi-server` writes a record under `~/.doompi/run` by default. The record names its process, working directory, Unix sockets, and attach-token file. `--registry-dir` or `DOOMPI_RUNTIME_DIR` moves the registry.

The hub watches those records, confirms the server process is live, reads the token file, and performs the socket handshake. The token remains in the hub process. Browser-supplied `attach` frames are rejected because the browser is not part of this trust boundary.

The registry is deliberately simple filesystem coordination. It lets independently started servers appear without a central daemon. The tradeoff is that the registry contains trusted paths. It must remain owner-only even though it stores the token path rather than the token value.

## Browser multiplexing

One browser WebSocket carries hub events, commands, histories, plugin channel frames, and traffic for many sessions. Session traffic is tagged with its session ID so the focused session can change without opening a new connection.

The hub keeps a bounded in-memory frame ring for each attached server. When a page subscribes again, it receives what remains in that ring and a dropped-frame count. This is reconnect assistance, not durable event storage. The session server and Pi protocol own authoritative session state.

This arrangement allows several tabs to observe one session without competing for the server's single authenticated client slot. The hub occupies that slot and fans traffic out to browser pages.

## Per-session composition

The shell is part of the installed `@agimon-ai/doompi-web` package. Plugin UI is not baked permanently into that shell. For each session, the hub uses the session working directory to select one synchronized plugin composition:

1. Try the complete registration for the session's repository or worktree.
2. Fall back to the complete global web registration when the repository has no usable web output.
3. Keep the package-owned shell with built-in surfaces when no plugin composition is available.

A selected generation supplies the client plugin composition, hub channels, and package APIs together. Repository and global artifacts are not mixed inside one session.

This is why the cockpit can focus a session from repository A, load its UI, then focus repository B and activate a different UI without replacing the hub. [Web bundling and serving](bundle.md) covers the build and signed publication design.

## Extension paths

DoomPi packages extend the system along two independent paths:

```text
doompiWeb
  +-- browser webPlugin ------> compiled client composition
  +-- webHubChannels ---------> modules loaded in the hub

doompiServer (one generation-pinned descriptor)
  +-- eligible hub facet -----> handler running in the hub
  +-- eligible session facet -> handler running beside the agent
```

A browser plugin controls presentation and page state. A hub channel maintains live host-side data for that presentation. A package API handles request-response work in the process that owns the required resources.

These are separate contracts on purpose. Not every panel needs a channel, not every channel needs an HTTP route, and a session API should not move into the hub merely to become reachable from the browser. See [Web plugins](plugins.md) and [Package APIs](package-apis.md).

## API routing boundary

All package routes use `/api/plugin/<basePath>`. The selector determines where the request goes:

- `session=<session-id>` proxies to the API socket owned by that session server.
- `hubSession=<session-id>` selects the hub API registry associated with that session's composition.
- no selector uses the hub's deterministic default API registry.

The hub removes routing selectors before invoking the package handler. It also removes caller-supplied identity headers and writes trusted locality, device, and step-up context. Package handlers still own input validation and authorization for their operation.

Built-in routes remain hub-owned. They cover health, session management, files, settings, provider authentication, remote access, PWA bootstrap, and signed publications.

## Lifecycle

```text
start hub
  -> initialize and synchronize the global cockpit root
  -> read existing session records
  -> synchronize session roots on demand
  -> attach to live servers
  -> load each session's hub channels and web composition
  -> accept browser connections
```

Creating or restarting a session synchronizes its configuration root before launching the server. An already running session server does not replace its extensions or session APIs when files on disk change. Restart that session after synchronization when server-side composition changes.

Only the global synchronization guard remains watched. A completed global sync reloads channels for sessions using the global composition without replacing the shell. A repository passed with `--dir` is synchronized on demand, not watched.

## Local and remote listeners

The normal listener binds loopback. Remote access creates a second loopback listener and points `cloudflared` at it. Both reach the same application, but the accepted socket marks whether a request arrived through the local or tunnel listener before authorization runs.

This distinction cannot be delegated to a proxy header because a tunnel connection also arrives from loopback and a remote caller can forge headers. Tunnel WebSockets require a paired device and a purpose-specific sealed channel. Remote HTTP operations use the sealed gateway except for the small bootstrap allowlist.

See [Remote security](security.md) for the threat model, authentication, code-delivery protection, and containment limits.
