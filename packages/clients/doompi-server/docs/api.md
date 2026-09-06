# Session APIs

Session APIs let a DoomPi package add HTTP behavior beside the agent it extends. The handler runs in `doompi-server`, receives session context from the host, and is reached through a local Unix socket. A browser never loads the server module directly.

This guide also covers the package's TypeScript exports. They are a separate surface for Node.js callers that want to compose the server services themselves.

## The design

```text
package.json doompiApi declaration
                |
                v
       doompi sync generation
         session.routes.mjs
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

The generated route module is part of the synchronized composition. That matters for two reasons:

- the API implementation follows the same repository and package selection as the agent
- discovery and validation happen during sync instead of by scanning arbitrary modules at request time

The server starts each handler once, routes requests to it by a fixed base path, and calls `close()` during shutdown. One broken optional API is isolated so it does not take down the agent or unrelated packages.

## Why the API is process-local

A session API may inspect session state, read bounded files, or control a package service. It therefore runs next to the session and receives trusted host context. The server exposes it on `api.sock`, not on a network port.

DoomPi Web owns browser authentication and proxies approved requests to that socket. Keeping those responsibilities separate avoids teaching every package about device cookies, tunnels, and session discovery. It also means a handler must not mistake local transport for validation: package code still has to validate input and enforce its own resource bounds.

Hub-wide APIs are a different scope and run in DoomPi Web. See the web package API guide when an operation belongs to the machine or repository rather than one live agent session.

## Declare a session API

A package declares `doompiApi` in `package.json`:

```json
{
  "doompiApi": {
    "basePath": "runner",
    "session": {
      "entry": "./src/api/session.ts",
      "dist": "./dist/api/session.mjs"
    }
  }
}
```

The field can also contain an array of declarations. `basePath` is kebab-case. `entry` and `dist` are package-relative paths without `..`; `dist` is required because the server imports built JavaScript, not package source.

A package without session API metadata contributes nothing to this surface. A declaration is available only when it belongs to the synchronized package composition selected for the session.

## Implement the handler

The generated registry exports an `apis` array. Each entry implements the same lifecycle:

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

A typical package exports one named `api` value through its built entry. The generated registry collects those exports for the server.

## Selecting the API composition

The server resolves the synchronized repository containing the session working directory. Its `session.routes.mjs` is the API composition for that agent. If no repository registration is available, the server falls back to the installation that launched it. `DOOMPI_API_DIR` is an explicit operator override.

This keeps APIs aligned with the agent instead of borrowing handlers from another live repository. A running server loads its API registry at startup; rebuild and restart the session after changing a server-side API.

No route module is a valid no-API state. If no handler starts successfully, the server does not create `api.sock` and the registry record has no `apiSocketPath`.

## Routing

The socket accepts only paths under:

```text
/api/plugin/<basePath>/<package route>
```

The host removes `/api/plugin/<basePath>` before calling the handler. A request to `/api/plugin/runner/runs/r1/log` therefore arrives as `/runs/r1/log`, with its remaining headers and body intact.

A path outside `/api/plugin/` returns `404`. An unknown base path returns a JSON `404`. A handler exception becomes a generic JSON `500`; the other APIs remain mounted.

When two loaded APIs claim the same base path, the first keeps it and the later declaration is skipped. Invalid registry values, modules without an `apis` array, and handlers whose `start()` throws are reported as notices rather than process failures.

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

The package export map is closed at `.` and `./package.json`. The main entry exposes the same building blocks used by the executable:

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
import { createAgentServerService, serveProtocolSocket, spawnAgentProcess } from '@agimon-ai/doompi-server';

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
import { serveSessionSocket } from '@agimon-ai/doompi-server';

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
