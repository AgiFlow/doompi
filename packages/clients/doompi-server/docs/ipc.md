# IPC and wire protocols

For a session, the server uses local Unix sockets for every client-facing transport. It does not open
a TCP listener for a session. The optional `--web` cockpit is a separate loopback HTTP listener. The
agent itself is a child process connected through newline-delimited JSON on stdin and stdout.

## Endpoints

| Endpoint                     | Transport                               | Role                                        |
| ---------------------------- | --------------------------------------- | ------------------------------------------- |
| `--listen <path>`            | newline-delimited JSON over Unix socket | Authenticated framed session attachment     |
| `<listen>.pi`                | Pi 0.85 routed Unix protocol            | Chord services and replicated session state |
| `dirname(<listen>)/api.sock` | HTTP over Unix socket                   | Session package APIs, when APIs are mounted |
| agent stdin and stdout       | newline-delimited JSON pipes            | Server to Pi RPC and Pi RPC to server       |

The registry record contains the absolute session, protocol, and optional package API socket paths. The
relaunch and composition files sit beside the session socket and are server-agent handoff files, not
client endpoints.

## Agent pipe

The server starts the resolved command with the caller's working directory and environment, then adds
`--mode rpc` to its arguments. Standard input and output are pipes. Standard error is inherited by the
process that started `doompi-server`, so agent diagnostics do not depend on an attached client.

The server decodes complete JSON objects separated by `\n`. A read can end in the middle of a frame;
the decoder retains that fragment until the next read. Empty lines are ignored. Frames are kept as
opaque objects (`Record<string, unknown>`) so Pi can evolve its RPC vocabulary without a second server
schema. Malformed client frames are rejected as described below.

## Framed session socket

### Attach handshake

The first frame on a new connection must be an `attach` frame with the token from the configured token
file:

```json
{ "type": "attach", "token": "..." }
```

An optional W3C `traceparent` field is accepted for server telemetry. A successful attach receives an
acknowledgement before any replay frames:

```json
{ "type": "attached", "replayed": 0, "dropped": 0 }
```

The server rejects the connection when:

- the first frame is not `attach`;
- `token` is not a string or does not match the configured token;
- another client already holds the session; or
- the stream contains malformed JSON.

Rejection uses this shape and then closes the connection:

```json
{ "type": "attach_error", "reason": "The attach token was rejected." }
```

Token comparison checks the lengths and compares equal-length bytes with a timing-safe comparison.
After the handshake, frames from the client go to the agent and frames from the agent go to the client
unchanged. The server does not reinterpret ordinary Pi RPC frames on this transport.

### One client and reconnects

Only one client can hold the framed session socket. A second connection is refused rather than sharing
writes with the first client. Closing the client connection does not stop the agent or the server.

While no client is attached, the server keeps a bounded backlog of up to 512 frames. The oldest frames
are dropped when the limit is exceeded. On the next attach, the server sends the `attached` acknowledgement
with the replay counts, then wraps each replayed frame:

```json
{ "type": "replay", "frame": { "type": "message_end" } }
```

`dropped` is the number of backlog frames discarded since the previous drain. The server also retains
the latest `extension_ui_request` projection for `setStatus` and `setWidget`, so a reconnect receives the
current status and widget state even when those frames were emitted while attached. A replay count can
therefore include both projections and backlog frames.

Frames are never added to the backlog while a client is attached. The backlog is an in-memory recovery
window, not durable session storage. The Pi routed protocol and its transcript snapshot provide the
authoritative state for clients that need more than that window.

## Pi routed protocol

The `<listen>.pi` endpoint is a Pi 0.85 `ServerHost` served by `@earendil-works/pi-server`. Its server
identity is generated at startup and recorded as `protocolServerId`. A Pi client should read both values
from the session registry and connect with the matching Unix transport and server id.

The host publishes two Chord services:

- `doompi.session-management.v1`: `attach(sessionId)` selects this server's one session, and
  `detach()` releases that attachment.
- `doompi.session.v1`: `state` is replicated session state; `prompt(text)`, `steer(text)`, `abort()`,
  `setModel({ provider, id })`, and `setThinking(level)` control the supervised agent.

The session service projects Pi RPC events into a snapshot plus transient progress. The snapshot carries
the session identity, working directory, phase (`idle`, `turn`, `compaction`, or `retry`), model,
thinking level, attachment and lock flags, revision, transcript, and queued steering messages.
Progress carries item start, update, and finish events while a turn is running. A prompt waits for
`agent_settled`; steering and abort require an active turn, and a second prompt while a turn is running
is rejected without dropping the protocol connection.

The protocol socket uses owner-only Unix-socket access. It has no `attach` token frame because filesystem
permissions are its local access boundary. It is a different protocol from the framed session socket;
clients should not send raw `attach` frames to `<listen>.pi`.

## Package API socket

When session package APIs are loaded, `api.sock` serves HTTP requests under
`/api/plugin/<basePath>/...`. The host strips that prefix before invoking a package handler. For example,
`/api/plugin/runner/runs/r1/log` reaches the `runner` API as `/runs/r1/log`. See [API](api.md) for the
mount and handler contract.

## Related guides

- [Lifecycle](lifecycle.md) explains startup order, relaunches, and cleanup.
- [API](api.md) documents package API routes and TypeScript exports.
- [Security](security.md) explains which Unix permissions and tokens protect these transports.
