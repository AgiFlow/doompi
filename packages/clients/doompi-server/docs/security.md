# Security and trust boundaries

`doompi-server` is a local process boundary, not a public network gateway. Its agent can run shell
commands and load extensions, so the command, working directory, configuration, token file, generated
API bundle, and package dependencies are trusted inputs. Anyone who can use the protected transports
can drive that agent with the same authority.

## What protects a session

| Asset                 | Protection                                                                                                             | Limit                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Framed session socket | Created with a `0177` umask and mode `0600`                                                                            | The owner account and root remain trusted; a writable parent can allow socket replacement                       |
| Attach token          | Read from `--auth-token-file`, compared with a timing-safe equal-length comparison, and never put in the server's argv | The server does not create or chmod the token file; the caller must keep it owner-only                          |
| Registry record       | Session directory is created `0700`; records are written atomically with mode `0600`; the token itself is not stored   | The record contains sensitive filesystem paths, and an existing custom directory is not tightened by the server |
| Pi protocol socket    | `@earendil-works/pi-server` is asked for mode `0600`                                                                   | It has no token handshake, so filesystem access is its authorization boundary                                   |
| Package API socket    | Unix socket beside the session socket, with no network bind                                                            | This package does not explicitly chmod `api.sock`; its creation mode follows Node and the process umask         |

Use a private parent directory and a restrictive umask. The quick start uses `umask 077` when it creates
the token. Apply the same care when choosing `--listen`, `--registry-dir`, or `DOOMPI_API_DIR` paths.
A custom registry location is a path override, not an additional authentication mechanism.

The registry stores `tokenFile`, `socketPath`, `apiSocketPath`, `protocolSocketPath`, `cwd`, and the
server pid. The web cockpit accepts paths from a valid live-PID record to locate the session, so exposing
registry files can disclose where to find the session and its credential. Keep the registry directory
private even though it does not contain the token contents.

## Token handling

The attach token is required for the framed session socket and must be present in a file before startup.
Do not put it in a command-line argument, a public environment variable, a checked-in file, or a shared
runtime directory. The server trims the file and refuses an empty value. A new token takes effect when
the server restarts; an already attached connection is not re-authenticated on every frame.

The server also generates an internal API token and passes it to the agent as
`DOOMPI_SESSION_API_INTERNAL_TOKEN`, alongside the API socket path. It passes the configured attach token
to trusted session APIs as their `hubToken` context. These values are for trusted child and package code;
the server does not send either value to a browser or put either value in a registry record.

Package APIs are executable code loaded from generated synchronization output. Treat them like other
extensions. A package API can see its session context and can choose to use the internal or hub token;
the host does not turn those values into automatic HTTP authorization.

## Browser and remote access

The session server exposes only Unix sockets. With `--web`, it asks `@agimon-ai/doompi-web` to host a
loopback cockpit or joins an existing DoomPi cockpit on the selected port. The cockpit reads session
token files on the host and keeps the Unix attach token server-side; a browser does not receive that
token or perform the Unix handshake itself.

Remote browser access is a separate web-cockpit boundary. Remote browsers carry bearer cookies issued
by the cockpit, not the session's Unix attach token. A bearer cookie is still authority to use the
cockpit and, through it, the agent. Apply the web package's origin, pairing, remote-access, and
container guidance before putting a cockpit on a tunnel or public interface. Do not expose `session.sock`,
`<listen>.pi`, or `api.sock` through an unauthenticated TCP forwarder.

A trusted SSH or local process tunnel changes reachability, not the session's trust model. The receiving
user still needs a deliberate authorization path to the socket and should not receive the token file
unless they are meant to control the session.

## Data and diagnostics

The framed socket forwards Pi RPC frames without redaction. The transcript projection keeps session
state and transcript content in memory for the routed service. Server telemetry records lifecycle,
transport, and coarse assistant usage events; its transcript aggregate deliberately omits message and
tool content. Agent stderr is inherited by the terminal that started the server, so treat that terminal
and any captured logs as trusted output.

## Operational checklist

- Create the token with `umask 077` and store it outside the repository.
- Keep the socket parent, registry directory, generated API directory, and token file owner-only.
- Treat `DOOMPI_AGENT_COMMAND`, repository-local DoomPi packages, generated API modules, and agent
  configuration as executable code.
- Give the protocol socket and package API socket only to trusted local processes.
- Use the web cockpit's documented remote controls instead of publishing a Unix socket directly.
- Rotate the token by stopping the server, replacing the owner-only token file, and starting it again.
- Do not rely on a registry path, `DOOMPI_RUNTIME_DIR`, or a custom port as an authorization check.

## Known limits

Filesystem permissions do not defend against root, a compromised owner account, or a process that has
already been granted the token. Unix sockets have no built-in TLS. Package API handlers and the agent
are trusted code, not a sandbox. The web cockpit's bearer-cookie and remote-access controls are outside
this package and must be reviewed separately.

See [IPC](ipc.md) for the exact handshake and socket behavior and [Lifecycle](lifecycle.md) for cleanup
and crash handling.
