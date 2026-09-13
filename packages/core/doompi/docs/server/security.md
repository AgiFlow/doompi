# Security and trust boundaries

`doompi-server` protects access to one local agent runtime. It is not a sandbox and it is not a public gateway. The harness may run shell commands with the account's authority, so reaching its control surface is equivalent to controlling that session.

## The trust model

```text
trusted owner account
  |
  +-- doompi-server
        +-- DirectHarnessRuntime
        +-- configured extensions and server facets
        +-- session journal and in-process APIs
        +-- authenticated HTTP/WebSocket listener
  |
  +-- trusted local client or DoomPi Web
        +-- browser boundary owned by DoomPi Web
```

The server answers which callers can reach the session. Loopback binding and a random token narrow that set. They do not defend against root, a compromised owner account, hostile code already running as that owner, or a malicious extension loaded into the runtime.

Remote browser authentication, tunnel policy, passkeys, and containment belong to DoomPi Web. The server's listener is not a replacement for those controls.

## Security goals

The design aims to:

- keep the default listener on loopback;
- keep the session token out of process arguments and application state sent to clients;
- authenticate direct HTTP and `/api/pi` protocol access with a random capability;
- load only modules from an admitted, generation-pinned `server.bundle.json`;
- keep package handlers in process while isolating optional facet failures; and
- preserve session history ownership so two runtimes cannot write the same journal concurrently.

It does not attempt to:

- contain the harness or trusted package code;
- protect data from the account running the server;
- encrypt traffic when the listener is exposed without TLS; or
- authorize arbitrary reverse proxies or tunnels.

## Capability map

| Asset                       | Protection                                                             | Remaining trust                                                       |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| HTTP and `/api/pi` listener | Loopback by default; token required except health                      | Owner, root, token holder, and any exposed reverse proxy              |
| Listener token              | Read from a file and compared as a bearer capability                   | Caller creates and protects the file                                  |
| Server bundle               | Admitted generation, fingerprint, confined descriptor and module paths | Synchronized repository and package contents are trusted inputs       |
| Session journal             | Explicit history ownership and v4 JSONL storage                        | Owner and any process able to access the session directory            |
| Package APIs                | In-process registration and fixed route mounts                         | Handlers are trusted executable code                                  |
| Direct harness              | Same-process runtime with configured working directory and environment | Command, configuration, repository, model providers, and dependencies |

Create the token before launch with an owner-only umask:

```bash
(umask 077; openssl rand -base64 32 > "$token_file")
```

Do not store it in the repository, a shared runtime directory, a public environment variable, or an argument list. Rotating it requires stopping the server, replacing the protected file, and starting the session again.

## Listener authentication

`/api/health` is intentionally unauthenticated so a local supervisor can check readiness. Every other HTTP route and the `/api/pi` upgrade require the configured token. HTTP clients should use `Authorization: Bearer <token>` or `x-doompi-token`. A WebSocket client may use the same capability in its upgrade headers or query string. Prefer a header because URLs can appear in logs.

A token authenticates the caller to the session. It is not a per-operation permission system. A holder can prompt, steer, abort, change configuration, rewind, answer extension UI, and invoke mounted package APIs. Treat it as full session control.

## Descriptor and package trust

The server does not compile or discover package code while serving a request. It loads the admitted `server.bundle.json`, checks generation and fingerprint identity, confines each module path to that generation, filters ownership and scope, and then starts each eligible facet.

Required facet failures prevent readiness. Optional failures are reported and isolated. A malformed or missing descriptor never selects an alternate directory or legacy module set. This fail-closed behavior protects against accidentally running package code from a different repository generation.

Package handlers receive trusted process context, not automatic browser authorization. Validate bodies, bound reads and streams, constrain file paths to the intended scope, and do not return secrets merely because a request arrived with a valid server token.

## Browser and remote access

DoomPi Web owns browser authentication and proxies `/api/pi` to the session server. It can add the server token on the upstream request without exposing that token to browser JavaScript. A remote browser receives DoomPi Web's separate device and session credentials, which can still grant powerful session control.

Before putting the cockpit behind a tunnel, review the web package's pairing, origin, cookie, passkey, sealed transport, signed bundle, and optional container controls. Do not publish the server listener through an unauthenticated TCP forwarder. A tunnel changes reachability, not authority.

## Data, replay, and diagnostics

The session journal contains conversation and tool history according to the upstream v4 JSONL format. The runtime also keeps current transcript state, in-flight work, and bounded presentation events in process memory. Presentation history is limited to 1,024 events or 8 MiB and reports dropped events; current projections are retained separately. This supports reconnect recovery but is not a durable audit log.

Server telemetry records lifecycle and coarse usage events. Its transcript aggregate omits message and tool content. This is a telemetry property, not a guarantee that clients, extensions, package APIs, or the harness do not log their own data.

## Operating posture

1. Create the token under an owner-only directory.
2. Keep the session journal, synchronized generation, and package modules private.
3. Treat repository configuration, model providers, extensions, and server facets as executable inputs.
4. Bind direct servers to loopback unless an authenticated TLS boundary is already in place.
5. Use DoomPi Web's documented controls for browser and remote access.
6. Rotate the token by replacing the file while the server is stopped.
7. Do not rely on an obscure path, port, or URL as authentication.

## Known limits

Loopback and file permissions do not defend against root or the owner account. A token holder can control the session. Package APIs and extensions run as trusted code. The replay window and transcript projection keep data in process memory, while the journal persists session history. None of these controls contain what the harness can do inside its working environment.

See [IPC](ipc.md) for exact protocol behavior and [Lifecycle](lifecycle.md) for startup, cleanup, and history recovery.
