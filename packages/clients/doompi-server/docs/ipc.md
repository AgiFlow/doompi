# IPC and wire protocols

`doompi-server` exposes one agent through three local interfaces. They are separate because they serve different clients and consistency models. The low-level session bridge carries Pi RPC frames, the routed protocol exposes replicated application state, and the package API socket serves HTTP handlers.

## The transport design

```text
                         doompi-server
                               |
         +---------------------+---------------------+
         |                     |                     |
         v                     v                     v
 framed session socket   Pi routed socket      package API socket
 raw Pi RPC stream       state and commands    HTTP package routes
 token + mode 0600       mode 0600             local filesystem boundary
         |
         v
 supervised Pi RPC child over stdin/stdout
```

All session transports are Unix sockets. The server does not open a TCP listener for them. This keeps discovery and authorization on the local filesystem and lets the browser hub hold session credentials without sending them to a page. The optional `--web` listener is a separate loopback HTTP service owned by DoomPi Web.

## Why there are three sockets

| Endpoint                     | Consumer                            | Contract                                                             |
| ---------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `--listen <path>`            | DoomPi Web and legacy frame clients | Authenticated, newline-delimited Pi RPC frames with reconnect replay |
| `<listen>.pi`                | Pi 0.85 protocol clients            | Routed Chord services and replicated session state                   |
| `dirname(<listen>)/api.sock` | Web hub and trusted local callers   | HTTP routes contributed by session packages                          |

The framed socket is intentionally narrow. It forwards the agent's protocol without inventing a second schema. The routed socket is the higher-level interface for clients that need authoritative state rather than a best-effort frame window. Package APIs remain HTTP because package features often already model requests, responses, streaming, and status codes that way.

The registry record publishes the absolute paths and protocol server ID needed to locate these interfaces. Relaunch and composition handoff files may sit beside them, but they are private server-agent state, not client endpoints.

## Agent pipe

The server starts the selected command in the session working directory, preserves the caller's environment, and adds `--mode rpc`. Agent stdin and stdout are newline-delimited JSON pipes. Agent stderr is inherited by the process that launched the server, so diagnostics remain visible even when no client is attached.

The frame decoder accepts complete JSON objects separated by `\n`. It retains a partial trailing frame until another read completes it and ignores empty lines. Decoded frames remain opaque `Record<string, unknown>` values. This allows Pi to evolve its RPC vocabulary without requiring the bridge to duplicate every message type.

## Framed session socket

### Why the server owns the attachment

Only one client can hold the framed socket at a time. Serial ownership prevents two clients from interleaving commands on one agent stdin stream. Multi-browser support belongs in DoomPi Web: the hub holds the single server attachment and multiplexes browser tabs above it.

The connection is authenticated because knowing a local socket path is not treated as sufficient authority for this low-level control channel.

### Attach handshake

The first frame must contain the token from `--auth-token-file`:

```json
{ "type": "attach", "token": "..." }
```

An optional W3C `traceparent` is accepted for telemetry. After validating the token and exclusive attachment, the server acknowledges before sending any replay:

```json
{ "type": "attached", "replayed": 0, "dropped": 0 }
```

The server rejects and closes the connection when the first frame is not `attach`, the token is missing or wrong, another client already owns the session, or the stream contains malformed JSON. Errors use an `attach_error` frame:

```json
{ "type": "attach_error", "reason": "The attach token was rejected." }
```

Token comparison checks lengths first and uses a timing-safe comparison for equal-length bytes. After attachment, ordinary frames pass between client and agent unchanged.

### Reconnect window

A client disconnect does not stop the agent. While detached, the server retains up to 512 frames in memory. When the limit is exceeded, the oldest frames are dropped.

The next successful attachment receives the replay and drop counts, followed by wrapped frames:

```json
{ "type": "replay", "frame": { "type": "message_end" } }
```

The `dropped` count reports frames discarded since the previous drain. The server also keeps the latest `extension_ui_request` projections for status and widget updates, so the replay count can include those snapshots as well as backlog frames.

Frames are not added to the backlog while a client is attached. The backlog is a short recovery window, not durable history. A client that needs authoritative state after a long absence should use the routed protocol snapshot.

## Pi routed protocol

The `<listen>.pi` socket hosts a Pi 0.85 `ServerHost` through `@earendil-works/pi-server`. Its generated identity is stored in the registry as `protocolServerId`; clients must use that ID with the recorded socket path.

The host publishes two Chord services:

- `doompi.session-management.v1` attaches or detaches this server's one session.
- `doompi.session.v1` replicates state and accepts `prompt`, `steer`, `abort`, `setModel`, and `setThinking` commands.

The session service projects Pi RPC events into a stable snapshot plus transient progress. The snapshot includes identity, working directory, phase, model, thinking level, attachment and lock state, revision, transcript, and queued steering messages. Progress reports item start, update, and finish while a turn runs.

A prompt waits for `agent_settled`. Steering and abort require an active turn. A second prompt during a turn is rejected without dropping the protocol connection.

This socket has no `attach` token frame. Owner-only filesystem access is its authorization boundary, and its wire protocol is not the framed session protocol. Sending a raw `attach` frame to `<listen>.pi` is a protocol error.

## Package API socket

When at least one session API starts, `api.sock` serves HTTP below:

```text
/api/plugin/<basePath>/...
```

The server removes `/api/plugin/<basePath>` before invoking the package handler. For example, `/api/plugin/runner/runs/r1/log` reaches the `runner` handler as `/runs/r1/log`.

The socket is absent when no API starts successfully. See [Session APIs](api.md) for discovery, context, failure isolation, and handler lifetime.

## Security boundary

Unix sockets replace network reachability with filesystem reachability; they do not make callers harmless. The framed socket adds a token, while the routed and package API sockets rely on private paths and permissions. A process running as the owner or root remains trusted.

Do not expose these sockets through an unauthenticated TCP forwarder. DoomPi Web provides the separate browser and remote-access boundary described in [Security](security.md).

## Related guides

- [Lifecycle](lifecycle.md) explains why the sockets outlive client attachments and agent generations.
- [Session APIs](api.md) defines the package handler contract.
- [Security](security.md) explains credentials, permissions, and trusted processes.
