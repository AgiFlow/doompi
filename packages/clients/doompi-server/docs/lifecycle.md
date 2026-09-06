# Session lifecycle

`doompi-server` separates the lifetime of an agent from the lifetime of any client. One server owns one agent, one session identity, and the local services used to reach it. A browser tab or socket client can disappear without taking the session with it.

## The ownership model

```text
doompi-server process
  |
  +-- agent supervisor
  |     +-- one Pi RPC child at a time
  |
  +-- framed session socket
  +-- Pi routed protocol socket
  +-- optional package API socket
  +-- session registry record
  +-- optional embedded web hub
```

The server, not a client, is the lifecycle owner. This choice gives reconnects and agent relaunches a stable boundary: sockets, session identity, and discovery can remain available while a client disconnects or the child process changes.

The registry record exists only while the server claims responsibility for those services. It is discovery state, not the source of session lifetime.

## Why one agent per server

A server process supervises one agent instead of multiplexing several agents internally. This keeps failure and identity boundaries simple:

- one exit status belongs to one session
- one relaunch handoff can replace one composition
- one working directory and session ID describe every service
- a client never has to select an agent after reaching a session socket

DoomPi Web provides multi-session aggregation above this layer. It watches multiple server records and gives the browser one cockpit connection.

## Startup is readiness-ordered

The server publishes itself only after the agent and local transports are ready:

```text
parse options and identity
          |
          v
read attach token and resolve agent
          |
          v
start supervisor and Pi RPC child
          |
          v
bind session, API, and protocol sockets
          |
          v
publish registry record
          |
          v
start or join optional web hub
```

The executable performs these steps:

1. Parse server options before `--`; preserve everything after it for the agent. `--listen` and `--auth-token-file` are required.
2. Read and trim the token file. An empty token stops startup. The token is not a command option, so it does not appear in the server argument vector.
3. Resolve the registry directory and session identity. The server generates a UUID unless `--session-id` is supplied. `--name` defaults to `untitled`. Agent-side identity flags take precedence, and missing flags are appended to the agent arguments.
4. Resolve the agent launcher. Repository-local DoomPi wins, `DOOMPI_AGENT_COMMAND` is the next fallback, and the installed DoomPi package can compose the session in process.
5. Start the supervisor and first agent with `--mode rpc`. The supervisor clears an old relaunch handoff, watches for a new one, and retains early frames until a server consumer subscribes.
6. Probe and remove a stale session socket, then bind the framed socket. Mount package APIs when a generated API directory is available and start the Pi routed protocol socket.
7. Write the registry record atomically. Readers see a complete old record or a complete new record, never a temporary document.
8. When `--web` is enabled, probe the requested port after registration. Reuse an existing DoomPi hub or start the optional web package on loopback.

A startup error is written to stderr with a `[doompi-server]` prefix and exits non-zero. Successful startup waits for the supervised agent, not for a client to connect.

## Keeping composition with the repository

A headless session should run the DoomPi installation selected by its repository, not whichever package happens to be nearest to the server executable. Agent resolution follows that rule:

1. A repository-local `@agimon-ai/doompi` installation wins. The server delegates to its `dist/bin/cli.mjs`.
2. Without a repository-local installation, `DOOMPI_AGENT_COMMAND` can select a JavaScript module or executable. `.js` and `.mjs` values run under the current Node executable.
3. With neither, the server calls the installed DoomPi preparation API, ensures selected layer packages, and launches the resulting Pi command.

Composition errors stop startup before an agent is spawned. The server does not publish a record for a session it could not construct.

The initial agent arguments are retained for relaunch. A requested major mode replaces the existing `--major-mode` pair instead of adding another one. Script position and all unrelated arguments remain stable.

## Steady state

Once ready, the server holds a stable session boundary:

| Owned resource                      | Lifetime                                    |
| ----------------------------------- | ------------------------------------------- |
| Session ID and name                 | Whole server process                        |
| Framed socket at `--listen`         | Whole server process                        |
| Pi protocol socket at `<listen>.pi` | Whole server process                        |
| `api.sock`                          | While one or more session APIs are mounted  |
| Registry record                     | While the server owns the session           |
| Agent child                         | One generation; replaceable during relaunch |

Agent frames feed the framed client, routed session service, and transcript projection independently. Losing one consumer does not end the agent. In particular, closing the framed client only begins the bounded reconnect window described in [IPC](ipc.md).

## Major-mode relaunch

Some major-mode changes replace the extension closure and cannot be applied safely inside the current Pi process. The server treats that as an agent-generation change, not a session change.

When the agent is idle, DoomPi writes a version `1` handoff to `DOOMPI_RELAUNCH_FILE`. It contains a non-empty `majorMode` and an `operationId`. The supervisor then:

1. ends the current agent's input
2. waits up to 15 seconds for Pi RPC to flush and exit
3. kills the child if it ignores the graceful exit
4. validates and consumes the handoff
5. resolves the requested composition and starts a replacement agent
6. keeps the session ID, sockets, registry record, and client-facing services

Clients remain attached to the server and receive frames from the replacement generation when it is ready.

A malformed handoff is ignored. An agent exit without a valid handoff is a real session exit. If the next composition cannot be built, the server returns the previous agent's exit code and does not publish or start a partial replacement.

## Shutdown and failures

`SIGINT` and `SIGTERM` disable relaunches and stop the current agent. After the agent exits, the server closes the optional web hub, package API server, Pi protocol socket, and framed socket. It then releases staged composition resources, removes the registry record and socket files, and flushes telemetry with a bounded wait.

An ordinary agent exit is returned as the executable's exit code. A hard process crash can leave registry and socket files because cleanup never ran. Recovery is defensive:

- DoomPi Web checks the recorded process ID and removes dead records.
- A later server probes a leftover session socket before removing it.
- A live socket is never stolen. The new server lets `listen` fail instead.

This favors refusing an ambiguous live path over silently attaching a new process to another session's identity.

## Related guides

- [Getting started](getting-started.md) covers launch options and web integration.
- [IPC](ipc.md) explains the transports that remain stable across reconnects and relaunches.
- [Session APIs](api.md) explains when API modules load and close.
- [Security](security.md) describes the filesystem and credential boundaries used throughout the lifecycle.
