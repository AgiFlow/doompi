# Session APIs

Session APIs let a DoomPi package add HTTP behavior beside the agent it extends. The handler runs in `doompi-server`, receives session context from the host, and is reached through a local Unix socket. A browser never loads the server module directly.

This guide also covers the package's TypeScript exports. They are a separate surface for Node.js callers that want to compose the server services themselves.

## The design

```text
package.json doompiServer declaration
                |
                v
       doompi sync generation
         server.bundle.json
                |
                v
         doompi-server
      start(context) per API
                |
                v
    HTTP over local api.sock
                |
         DoomPi Web proxy
                |
              browser
```

The descriptor and its pinned facet modules are part of the synchronized composition. That matters for two reasons:

- the API implementation follows the same repository and package selection as the agent
- discovery and validation happen during sync instead of by scanning arbitrary modules at request time

The server starts each handler once, routes requests to it by a fixed base path, and calls `close()` during shutdown. One broken optional API is isolated so it does not take down the agent or unrelated packages.

## Why the API is process-local

A session API may inspect session state, read bounded files, or control a package service. It therefore runs next to the session and receives trusted host context. The server exposes it on `api.sock`, not on a network port.

DoomPi Web owns browser authentication and proxies approved requests to that socket. Keeping those responsibilities separate avoids teaching every package about device cookies, tunnels, and session discovery. It also means a handler must not mistake local transport for validation: package code still has to validate input and enforce its own resource bounds.

Hub-wide APIs are a different scope and run in DoomPi Web. See the web package API guide when an operation belongs to the machine or repository rather than one live agent session.

## Declare a session API

A package declares one `doompiServer` facet in `package.json`:

```json
{
  "doompiServer": {
    "entry": "./src/exports/extensions/server.ts",
    "dist": "./dist/extensions/server.mjs",
    "scopes": ["session"]
  }
}
```

Publish a default-exported `DoomServerFacet` object plugin through that entry. In its `apply`, use `requireDoomServerHost(context).registerApi(api)` and return a disposer that calls the registration's `dispose()`. Declare the host service in `inject` and check scope before registering. The API implementation owns its base path; no separate legacy API manifest field is needed.

Paths are package-relative and cannot escape the package. The host filters scope and effective package ownership before importing any facet. See the [complete facet example](../../../../clients/doompi-web/docs/package-apis.md#declare-an-api).

## Implement the handler

Each API registered by a facet implements this lifecycle:

```ts
interface DoomApi {
  basePath: string;
  start(context: DoomApiContext): {
    fetch(request: Request): Response | Promise<Response>;
    close(): void;
  };
}
```

`start()` creates session-owned resources once. `fetch()` handles requests relative to the package mount. `close()` must release timers, watchers, streams, and other resources created during startup.

Keep the API adapter reusable and have the server facet import it. The facet's disposer closes the registration.

## Selecting the API composition

The server resolves the synchronized repository containing the session working directory and loads its `server.bundle.json` descriptor. If no repository registration is available, it checks the installation that launched it. `DOOMPI_API_DIR` is an explicit operator override. A selected malformed descriptor fails admission, never silently falls back. Read-only aggregate compatibility is limited to explicitly admitted older generations.

This keeps APIs aligned with the agent instead of borrowing handlers from another live repository. A running server loads its API registry at startup; rebuild and restart the session after changing a server-side API.

An empty descriptor is a valid no-API state. Without mounted APIs, the server does not create `api.sock` and the registry record has no `apiSocketPath`. This is distinct from a failed required facet, which prevents readiness.

## Routing

The socket accepts only paths under:

```text
/api/plugin/<basePath>/<package route>
```

The host removes `/api/plugin/<basePath>` before calling the handler. A request to `/api/plugin/runner/runs/r1/log` therefore arrives as `/runs/r1/log`, with its remaining headers and body intact.

A path outside `/api/plugin/` returns `404`. An unknown base path returns a JSON `404`. A handler exception becomes a generic JSON `500`; the other APIs remain mounted.

When two eligible APIs claim the same base path, the first keeps it and the later registration is skipped. Optional import and installation failures receive package-attributed notices; required facet failures prevent readiness. Disabled candidates are not imported and do not reserve mount paths.

## Host context and authority

A session handler receives:

| Field           | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `scope`         | Always `session`                                            |
| `sessionId`     | Resolved identity of the owning server                      |
| `cwd`           | Agent working directory                                     |
| `internalToken` | Random token shared with the child session environment      |
| `hubToken`      | Configured attach token shared with trusted cockpit context |
| `onNotice`      | Host-visible diagnostic callback                            |

The server does not pass a browser credential to the package API. `internalToken` and `hubToken` are process context for trusted package code, not automatic route authorization. If a handler needs caller locality, device identity, or step-up status from DoomPi Web, it must use the trusted caller context stamped by that proxy rather than accept browser-supplied authorization headers.

Package APIs are executable trusted code. Validate bodies, bound reads and streams, constrain file paths to the intended scope, and do not return secrets merely because the request arrived on a Unix socket.

## TypeScript server exports

The core package publishes the server building blocks through `@agimon-ai/doompi/server`:

| Export                                    | Responsibility                                                   |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `spawnAgentProcess`                       | Start one RPC agent with piped stdin/stdout and inherited stderr |
| `serveSessionSocket`                      | Serve the token-protected framed socket and reconnect backlog    |
| `serveProtocolSocket`                     | Serve the Pi 0.85 routed host over a Unix socket                 |
| `createAgentServerService`                | Compose management and session services around one agent         |
| `createAgentSessionRuntime`               | Project agent frames into replicated state and progress          |
| `createRpcTranscript`                     | Reduce Pi RPC events into the transcript model                   |
| `createFrameDecoder`, `encodeFrame`       | Decode and encode newline-delimited frames                       |
| `createDetachedBacklog`                   | Maintain the bounded detached-client window                      |
| `evaluateHandshake`                       | Validate the first attach frame and token                        |
| `parseServeOptions`, `SERVE_USAGE`        | Parse executable options                                         |
| `SESSION_RECORD_VERSION`, `SessionRecord` | Describe the discovery record                                    |

A minimal routed protocol composition looks like this:

```ts
import { createAgentServerService, serveProtocolSocket, spawnAgentProcess } from '@agimon-ai/doompi/server';

const agent = spawnAgentProcess({ command, args, cwd, env });
const service = createAgentServerService({
  agent,
  sessionId: 'session-id',
  sessionName: 'work',
  cwd,
  createdAt: Date.now(),
});
const protocol = await serveProtocolSocket({ socketPath: '/private/session.sock.pi', service });
```

For the lower-level framed transport, load the token from an owner-only file:

```ts
import { serveSessionSocket } from '@agimon-ai/doompi/server';

const socket = serveSessionSocket({
  socketPath: '/private/session.sock',
  token: tokenFromOwnerOnlyFile,
  agent,
});
```

Call `close()` on every returned service during shutdown. The executable's ordering and cleanup behavior are described in [Lifecycle](lifecycle.md).

## Related guides

- [IPC](ipc.md) explains the package API socket beside the other session transports.
- [Lifecycle](lifecycle.md) explains when API modules load and close.
- [Security](security.md) describes context tokens and the local trust boundary.
