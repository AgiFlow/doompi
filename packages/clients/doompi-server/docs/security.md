# Security and trust boundaries

`doompi-server` protects access to one local agent. It is not a sandbox and it is not a public gateway. The agent may run shell commands with the account's authority, so reaching its control interfaces is equivalent to controlling that agent.

## The trust model

```text
trusted owner account
  |
  +-- doompi-server
  |     +-- configured agent command and extensions
  |     +-- generated package APIs
  |     +-- Unix sockets and registry files
  |
  +-- trusted local client or DoomPi Web hub
          |
          +-- browser boundary owned by DoomPi Web
```

The server answers one question: which local processes can reach the session. Filesystem permissions and an attach token narrow that set. They do not defend against root, a compromised owner account, hostile code already running as that owner, or a malicious extension loaded into the agent.

Remote browser authentication, tunnel policy, passkeys, and containment belong to DoomPi Web. Adding `--web` does not turn the session server itself into a network security boundary.

## Security goals

The design aims to:

- keep session transports off public network interfaces
- avoid placing the attach token in process arguments or registry records
- let the web hub attach without giving the token to browser JavaScript
- make discovery records owner-only and atomically replaceable
- isolate a broken optional package API from the agent and other APIs

It does not attempt to:

- contain the agent or trusted package code
- protect data from the account running the server
- encrypt local Unix-socket traffic
- authorize arbitrary TCP forwarding of a socket

## Capability map

| Asset                 | Protection                                                               | Remaining trust                                                                     |
| --------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Framed session socket | Created under a `0177` umask with mode `0600`; attach token required     | Owner, root, token holder, and anyone able to replace a socket in a writable parent |
| Attach token          | Read from a file and compared with a timing-safe equal-length check      | Caller creates and protects the file                                                |
| Registry record       | Session directory `0700`; atomic record mode `0600`; token value omitted | Paths remain sensitive; existing custom directories are not tightened               |
| Pi protocol socket    | Requested mode `0600`                                                    | Filesystem access is the authorization boundary; there is no token handshake        |
| Package API socket    | Local Unix socket beside the session socket                              | Creation permissions follow the process umask; handlers are trusted executable code |
| Agent process         | Child of the server with the session working directory and environment   | Command, configuration, repository, and dependencies are trusted inputs             |

Use a private parent directory and a restrictive umask. Changing `--registry-dir` or `DOOMPI_RUNTIME_DIR` changes a location, not the authorization model.

## Why the framed socket also has a token

The framed socket is the lowest-level control path. After attachment, a client can send Pi RPC commands directly to the agent. Requiring both filesystem reachability and a random token gives the hub a deliberate capability to present rather than treating any process that discovers the path as attached.

The server reads and trims `--auth-token-file` during startup and rejects an empty value. The token never needs to appear in the command line. An attached connection is authenticated once, not on every frame. Rotating the token therefore requires stopping the server, replacing the protected file, and starting the session again.

The server does not create or chmod the token file. Create it before launch with an owner-only umask:

```bash
(umask 077; openssl rand -base64 32 > "$runtime_dir/token")
```

Do not store it in the repository, a shared runtime directory, a public environment variable, or an argument list.

## Registry records are capabilities by reference

A session record does not contain the token bytes, but it names `tokenFile`, `socketPath`, `protocolSocketPath`, optional `apiSocketPath`, `cwd`, and the server process ID. DoomPi Web trusts these values after confirming that the recorded process is alive.

The registry must therefore remain private. Reading it reveals where the session and its credential live; modifying it can redirect a watcher toward attacker-chosen paths. Atomic owner-only records prevent partial reads, but they do not make a writable custom parent safe.

## Internal API credentials

The server creates an internal API token and passes it to the child as `DOOMPI_SESSION_API_INTERNAL_TOKEN` with the API socket path. Trusted session APIs also receive the attach token as `hubToken` context.

These values coordinate trusted child and package code. They are not automatic HTTP authorization, and the server does not send them to a browser or write them into the registry. A package API can still misuse its context, so generated API modules must be treated like extensions: executable code with the owner's authority.

## Browser and remote access

With `--web`, the server either joins an existing DoomPi Web hub or starts one on loopback. The hub reads the token file and owns the one framed session attachment. Browser pages do not receive the Unix attach token and cannot perform that handshake themselves.

A remote browser receives a separate DoomPi Web device cookie. That cookie authorizes the cockpit, which can in turn control the agent. The distinction prevents exposing the session credential to browser JavaScript, but it does not make remote cockpit access less powerful.

Before putting the cockpit behind a tunnel, review the web package's pairing, origin, cookie, passkey, sealed transport, signed bundle, and optional container design. Do not publish `session.sock`, `<listen>.pi`, or `api.sock` through an unauthenticated TCP forwarder.

An SSH or local process tunnel changes reachability, not authority. Anyone given a path and token should be treated as a session controller.

## Data and diagnostics

The framed socket forwards Pi RPC content without redaction. The routed service keeps transcript and session state in memory. Agent stderr is inherited by the launching terminal and may contain diagnostics produced by the agent or extensions.

Server telemetry records lifecycle, transport, and coarse assistant usage events. Its transcript aggregate omits message and tool content. This is a telemetry property, not a guarantee that terminals, clients, extensions, or package APIs do not log their own data.

## Operating posture

1. Create the runtime and token under an owner-only directory.
2. Keep socket parents, registry files, token files, and generated API directories private.
3. Treat `DOOMPI_AGENT_COMMAND`, repository-local DoomPi packages, generated API modules, and agent configuration as executable inputs.
4. Give the protocol and package API sockets only to trusted local processes.
5. Use DoomPi Web's documented controls for browser and remote access.
6. Rotate the attach token by replacing the file while the server is stopped.
7. Do not rely on an obscure path, custom registry, or non-default port as authentication.

## Known limits

Unix permissions do not defend against root or the owner account. Unix sockets have no built-in TLS. A holder of the attach token can control the session. Package APIs and agent extensions run as trusted code. The reconnect backlog and transcript projection keep data in process memory. None of these controls contain what the agent can do inside its working environment.

See [IPC](ipc.md) for exact socket behavior and [Lifecycle](lifecycle.md) for startup, cleanup, and crash recovery.
