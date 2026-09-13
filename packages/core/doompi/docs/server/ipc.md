# Client protocol and in-process APIs

The canonical server has one client-neutral listener. It exposes HTTP routes and an authenticated WebSocket at `/api/pi`; the server keeps the Pi harness, typed session services, and package APIs in process.

## The transport design

```text
                       doompi-server
                             |
          +------------------+------------------+
          |                                     |
          v                                     v
   HTTP control surface                 /api/pi WebSocket
 health, sessions, APIs                Pi 0.85 Chord services
          |                                     |
          +------------------+------------------+
                             v
                 DirectHarnessRuntime
```

The listener binds to loopback by default. It is a network listener with an explicit bearer capability, not a filesystem endpoint. There is no internal raw command bridge and no separate API listener.

## HTTP routes

The server exposes these client-neutral routes:

| Route                                    | Contract                                    |
| ---------------------------------------- | ------------------------------------------- |
| `GET /api/health`                        | Unauthenticated readiness and session count |
| `GET /api/sessions`                      | Session metadata for the headless hub       |
| `GET /api/sessions/<id>`                 | One session's metadata                      |
| `GET /api/events`                        | Server-sent session and channel events      |
| `GET /api/sessions/<id>/channels`        | Current channel projections                 |
| `POST /api/sessions/<id>/channel/<type>` | Deliver a channel operation                 |
| `/api/sessions/<id>/api/<base-path>/...` | Dispatch a session package API in process   |

All routes other than health require the configured token. HTTP clients should send `Authorization: Bearer <token>` or `x-doompi-token`. The WebSocket may use the same capability in its authorization header or query string; avoid query strings when a header is available because URLs can be logged.

The old raw command route is not part of this surface. Session control uses the typed protocol described below.

## `/api/pi` protocol

`/api/pi` carries the Pi 0.85 byte protocol over an already-authenticated WebSocket. The server hosts the stable cockpit server identity and publishes these typed services:

- `doompi.hub.v1` lists sessions, subscribes to channel events, and sends typed channel operations;
- `doompi.session-management.v1` attaches and detaches a session; and
- `doompi.session.v1` exposes one session's state and operations.

A client first attaches through the management service, then binds the session service for that session. The service boundary is typed even though the transport carries protocol bytes.

## Typed session operations

`doompi.session.v1` exposes:

- `prompt`, with `waitFor: "accepted"` or `"settled"`;
- `steer`, `followUp`, `abort`, and `clearQueue`;
- `setModel`, `setThinking`, `compact`, and `setName`;
- `rewind`, including optional summarization and instructions;
- `extensionUiResponse`;
- `getState`, `getSessionStats`, and `getCommands`; and
- `getAvailableModels` and `getAvailableThinkingLevels`.

A prompt waits for the agent to settle by default. `accepted` returns after authoritative submission without owning the turn lifetime. A second prompt during a turn is rejected. Steering and abort require an active turn. Context cancellation aborts the active runtime operation.

The session state contains an authoritative transcript snapshot, phase, model, thinking level, queue, revision, transient progress, concurrent in-flight items, and presentation state. Typed query methods are the source of truth for current state, not an event stream assembled by a client.

## Replay and consistency

Chord state replication sends a fresh attachment the current service state. The session journal is the durable history source. Presentation events are retained in memory only, up to 1,024 events or 8 MiB, and the state reports how many were dropped. Current status, widget, dialog, and custom-entry projections are retained independently so a reconnect can recover current UI state. Branch navigation resets custom projections and increments `resetRevision`.

The hub's session and channel event history is also bounded to 1,024 events. These windows are reconnect aids, not durable history. Clients should resnapshot and use typed queries whenever a revision gap or dropped count is observed. Query replies for full history and model discovery are not treated as replayable presentation events.

## Session package APIs

A package API is registered by a server facet and called through the in-process `Request` adapter. The listener strips `/api/sessions/<id>/api/<base-path>` before invoking the handler, so a request to `/api/sessions/one/api/runner/runs/r1/log` reaches the `runner` handler as `/runs/r1/log`.

Package handlers run with the session's trusted host context. They still validate request bodies, bound reads and streams, constrain paths, and avoid returning secrets merely because the caller passed the listener token.

## Related guides

- [Lifecycle](lifecycle.md) explains startup, readiness, and shutdown.
- [Session APIs](api.md) defines descriptor loading and the TypeScript surface.
- [Security](security.md) explains token validation, listener exposure, and trusted code.
