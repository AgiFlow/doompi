# Session APIs

This guide covers two surfaces that are easy to confuse:

1. session package APIs, which are HTTP handlers mounted on a local `api.sock`; and
2. the TypeScript exports from `@agimon-ai/doompi-server`, which let another Node process compose the
   same services.

## Session package APIs

A package declares a session API in its `package.json` under `doompiApi`. The declaration names a
kebab-case base path and a built module for each scope it offers:

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

The manifest can contain an array of declarations. `entry` and `dist` must be package-relative paths
without `..`; `dist` is required because the host imports the built module. A generated API bundle
exports an `apis` array. Each entry has this shape:

```ts
interface DoomApi {
  basePath: string;
  start(context: DoomApiContext): {
    fetch(request: Request): Response | Promise<Response>;
    close(): void;
  };
}
```

A package's API is mounted only when its declaration is included in the generated session bundle. The
server resolves that bundle from the synchronized repository containing the session's working directory.
If that repository has no registration, it falls back to the installation that launched the server.
`DOOMPI_API_DIR` overrides the generated directory. The server imports `<api directory>/session.routes.mjs`;
no module is an ordinary no-API state.

Broken entries do not take down the agent. The loader skips invalid values, duplicate base paths, and
modules that do not export an `apis` array. If an API's `start()` throws, that API stays unmounted and
the server notices the failure. When two loaded APIs claim a base path, the first one keeps it.

### Routes and handler paths

The server binds the package API server to `api.sock` in the session socket directory. It accepts only
paths below `/api/plugin/`:

```text
/api/plugin/<basePath>/<package route>
```

The mount prefix is removed before the handler runs. A request to
`/api/plugin/runner/runs/r1/log` therefore reaches the `runner` handler as `/runs/r1/log`. The handler
also receives the original request headers and body.

A path outside `/api/plugin/` returns HTTP 404. An unknown base path returns a JSON 404. An exception
from a handler returns a generic JSON 500 and the other APIs remain available. Closing the server calls
every mounted handler's `close()` method and removes `api.sock`. If no API starts successfully, the
socket is not created and the registry record has no `apiSocketPath`.

### Host context

A session API receives a context with:

| Field           | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| `scope`         | Always `session`                                                          |
| `sessionId`     | The server's resolved session id                                          |
| `cwd`           | The agent's working directory                                             |
| `internalToken` | A server-generated random token shared with the child session environment |
| `hubToken`      | The configured attach token, shared with the cockpit hub context          |
| `onNotice`      | A callback for host-visible diagnostics                                   |

The server does not pass a browser credential to the package API. The internal and hub tokens are
process context for trusted package code, not route authentication. A session API is local to the
server's Unix socket; the web cockpit is responsible for authenticating and proxying browser requests.

## TypeScript server exports

The package keeps its export map closed at `.` and `./package.json`. The main export includes these
roles:

| Export                                    | Role                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `spawnAgentProcess`                       | Spawn one RPC agent with piped stdin and stdout and inherited stderr |
| `serveSessionSocket`                      | Serve the token-protected framed Unix socket with reconnect backlog  |
| `serveProtocolSocket`                     | Serve a Pi 0.85 routed `ServerHost` over a Unix socket               |
| `createAgentServerService`                | Build management and session services around one agent               |
| `createAgentSessionRuntime`               | Project agent frames into replicated snapshot and progress state     |
| `createRpcTranscript`                     | Reduce Pi RPC events into the session transcript model               |
| `createFrameDecoder`, `encodeFrame`       | Decode and encode newline-delimited JSON frames                      |
| `createDetachedBacklog`                   | Provide a bounded detached-client replay buffer                      |
| `evaluateHandshake`                       | Validate the first attach frame and token                            |
| `parseServeOptions`, `SERVE_USAGE`        | Parse the executable's server options                                |
| `SESSION_RECORD_VERSION`, `SessionRecord` | Describe the registry record format                                  |

A minimal protocol composition looks like this:

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

`serveSessionSocket` uses the same `AgentProcess` but exposes the lower-level framed transport. Load the
token from an owner-only file before constructing the socket:

```ts
import { serveSessionSocket } from '@agimon-ai/doompi-server';

const socket = serveSessionSocket({
  socketPath: '/private/session.sock',
  token: tokenFromOwnerOnlyFile,
  agent,
});
```

Call `close()` on each returned server during shutdown. The executable's complete ordering, including
agent supervision and registry cleanup, is in [Lifecycle](lifecycle.md).

## Related guides

- [IPC](ipc.md) has wire examples for the framed and Pi protocol sockets.
- [Lifecycle](lifecycle.md) explains when API modules load and when the socket closes.
- [Security](security.md) describes the local access boundary and context token handling.
