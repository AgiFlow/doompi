# Session lifecycle

`doompi-server` owns the lifetime of one agent process and the local services that expose it. The
session record exists only while the server is responsible for those services.

## Startup

The executable starts in this order:

1. It parses server options before `--` and keeps the remaining arguments for the agent. `--listen`
   and `--auth-token-file` are required.
2. It reads and trims the token file. An empty file stops startup. The token is not accepted as a
   server option, so it does not appear in the server's argument vector.
3. It resolves the registry directory, then resolves the session identity. The server generates a
   UUID unless `--session-id` is supplied. `--name` defaults to `untitled`. An agent-side
   `--session-id` or `--name` takes precedence, and missing identity flags are appended to the agent
   arguments.
4. It creates the agent launcher. A repository-local `@agimon-ai/doompi` installation is used when
   present. Otherwise `DOOMPI_AGENT_COMMAND` can select a binary or JavaScript module. With neither,
   the server composes the installed DoomPi package in process. Composition errors fail startup before
   an agent is spawned.
5. It starts the supervisor and the first agent. The server appends `--mode rpc` to the resolved agent
   arguments. The supervisor clears a leftover relaunch handoff, watches for a new one, and retains
   early agent frames until a server consumer subscribes.
6. It removes a socket left by a dead process, without taking a live socket path, and binds the framed
   session socket. It then mounts session package APIs when a generated API directory is available and
   starts the Pi routed protocol socket.
7. It writes the registry record atomically. A reader sees either the previous complete record or the
   new complete record, never a temporary JSON document.
8. If `--web` was requested, it probes the configured port after registration. An existing DoomPi hub
   is reused; otherwise the optional web package starts a loopback hub in this process.

The server reports startup failures to stderr with a `[doompi-server]` prefix and exits non-zero. A
successful startup waits on the supervised agent, not on a client connection.

## Agent selection and composition

The server keeps the repository's composition with the agent that it launches:

- A parent directory containing a different repository-local `@agimon-ai/doompi` package wins over
  the server's own installation. The server delegates to that package's `dist/bin/cli.mjs`.
- If no repository-local package is found, `DOOMPI_AGENT_COMMAND` is the global fallback. A `.mjs` or
  `.js` command runs under the current Node executable; another value is spawned as a command.
- If neither fallback applies, the server calls DoomPi's published preparation directly, ensures the
  selected layer packages, and launches the resulting Pi command.

The initial argument list is retained for a relaunch. The target major mode replaces any previous
`--major-mode` pair rather than accumulating another flag. This keeps a script path at the front of a
Node-based command and puts the new selection at the end.

## Steady state

The process owns these services:

- `--listen`, the authenticated framed session socket.
- `<listen>.pi`, the Pi 0.85 routed protocol socket.
- `api.sock` beside the session socket, only when one or more session package APIs start successfully.
- A registry record under `<registry-dir>/sessions/`.

The sockets and the registry keep the same session id for the whole server lifetime. Agent frames feed
the framed client, the routed session service, and the transcript projection independently. A client
connection is not the agent's lifetime: a disconnect only removes that client from the framed socket.

## Major-mode relaunch

A launcher-class session cannot replace its extension closure in place. When the DoomPi runtime is idle
and requests a relaunch, it writes a JSON handoff to the path in `DOOMPI_RELAUNCH_FILE`. The handoff
contains version `1`, a non-empty `majorMode`, and an `operationId`.

The supervisor then:

1. notices the handoff file and ends the current agent's input;
2. waits up to 15 seconds for Pi RPC to flush and exit;
3. kills the agent if it ignores the graceful-exit request;
4. validates and consumes the handoff file;
5. resolves the requested major mode and spawns the replacement;
6. keeps the same session id, sockets, registry record, and client-facing services.

A malformed handoff is ignored. An exit without a valid handoff is a real session exit. If the target
composition cannot be built, the old exit code is returned and the server does not start a partial
composition. While the replacement starts, clients stay attached to the server and receive frames from
the new agent generation when it is ready.

## Shutdown and cleanup

`SIGINT` and `SIGTERM` stop the supervised agent and disable relaunch handling. When the agent exits,
the server closes the optional cockpit, package API server, Pi protocol socket, and framed session
socket. It cleans staged composition resources, removes the session record, removes socket files, and
flushes telemetry with a bounded shutdown wait.

An agent exit without a relaunch handoff returns its exit code to the executable. A crash can leave a
registry record behind because no cleanup code ran. The web cockpit checks the recorded pid and removes
stale records. On the next server start, a stale session socket is removed only after its probe fails;
a live socket is left in place so `listen` fails rather than silently stealing another session.

## Related guides

- [IPC](ipc.md) describes each socket and the attach and replay sequence.
- [API](api.md) describes mounted package APIs and the exported TypeScript services.
- [Security](security.md) describes the filesystem capabilities used during this lifecycle.
