# Session APIs

Session APIs let a DoomPi package add HTTP behavior beside the direct headless runtime it extends. A package facet is loaded from the admitted `server.bundle.json` descriptor, registered in `doompi-server`, and called in process. The public client route is `/api/sessions/<session-id>/api/<base-path>/...`.

This guide also covers the package's TypeScript exports for Node.js callers that want to compose the same in-process services.

## The design

```text
package.json doompiServer declaration
                |
                v
        doompi sync generation
                |
                v
         server.bundle.json
                |
                v
       direct headless host
       start(context) per API
                |
                v
       in-process Request dispatch
                |
                v
 /api/sessions/<id>/api/<base-path>/...
```

The descriptor and its pinned facet modules are part of the synchronized generation. This ensures:

- the API implementation follows the same repository, mode, and package selection as the session runtime;
- module paths remain confined to the admitted generation; and
- discovery and validation happen during synchronization and startup, not by scanning arbitrary modules at request time.

The server starts each handler once, routes requests by a fixed base path, and calls `close()` during shutdown. A broken optional API is isolated so it does not take down the runtime or unrelated packages.

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

Publish a default-exported `DoomServerFacet` through that entry. In its `apply`, use `requireDoomServerHost(context).registerApi(api)` and return a disposer that calls the registration's `dispose()`. Declare the host service in `inject` and check scope before registering. The API implementation owns its base path.

Paths are package-relative and cannot escape the package. The synchronized descriptor records the built module path and the package ownership used for admission. See the [complete facet example](../../../../clients/doompi-web/docs/package-apis.md#declare-an-api).

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

Keep the API adapter reusable and have the facet import it. The facet's disposer closes the registration.

## Selecting the API composition

The server accepts only an admitted synchronized generation or the installation generation that explicitly contains a valid `server.bundle.json`. It validates the descriptor's version, generation, fingerprint, entries, ownership, and confined module paths before importing facets.

The descriptor is the only composition source. A missing, malformed, stale, or mismatched descriptor fails admission. The server never scans arbitrary package manifests at request time and never silently falls back to an older API registry or an alternate module directory. Re-run `doompi sync` and restart after changing a server-side API.

An empty descriptor is a valid no-API state. In that case package API requests return `404`; the server still provides the typed session protocol. A required eligible facet failure prevents readiness. An optional facet failure is reported and does not remove unrelated APIs.

## Routing and isolation

The public path is:

```text
/api/sessions/<session-id>/api/<base-path>/<package route>
```

The server removes the session and package mount prefix before calling the handler. A path outside the route returns `404`. An unknown base path returns a JSON `404`. A handler exception becomes a generic JSON `500`; other APIs remain mounted. Invalid base paths are rejected before dispatch.

When two eligible APIs claim the same base path, the first keeps it and the later registration is skipped. Disabled candidates are not imported and do not reserve mount paths.

## Host context and authority

A session handler receives:

| Field           | Meaning                                                 |
| --------------- | ------------------------------------------------------- |
| `scope`         | Always `session`                                        |
| `sessionId`     | Identity of the owning session                          |
| `cwd`           | Session working directory                               |
| `internalToken` | Optional process context for trusted child coordination |
| `hubToken`      | Optional context for trusted cockpit coordination       |
| `onNotice`      | Host-visible diagnostic callback                        |

These values are process context for trusted package code, not automatic route authorization. A handler must validate its own inputs and enforce resource bounds. It must not accept browser-supplied authorization headers as proof of identity. If caller identity or step-up state matters, use the trusted context supplied by DoomPi Web.

Package APIs are executable trusted code. They can access the session's authority, journal, and working directory according to their implementation. Treat generated modules like extensions and review their path, body, stream, and secret handling.

## TypeScript server exports

The core package publishes the in-process building blocks through `@agimon-ai/doompi/server`:

| Export                              | Responsibility                                                   |
| ----------------------------------- | ---------------------------------------------------------------- |
| `createHeadlessSessionManager`      | Own direct session hosts and dispose them                        |
| `createHeadlessHub`                 | Aggregate sessions, channels, and package API dispatch           |
| `serveHeadlessServer`               | Expose HTTP and authenticated `/api/pi` WebSocket routes         |
| `createAgentSessionRuntime`         | Project a direct runtime into typed session state and operations |
| `createAgentServerService`          | Adapt one typed session service to the Pi protocol host          |
| `createRpcTranscript`               | Reduce runtime events into the authoritative transcript          |
| `createHeadlessChildSessionService` | Provide explicitly requested child-session capabilities          |

A minimal composition is:

```ts
import { createHeadlessHub, createHeadlessSessionManager, serveHeadlessServer } from '@agimon-ai/doompi/server';

const manager = createHeadlessSessionManager();
const hub = createHeadlessHub({ manager });
const server = await serveHeadlessServer({
  headlessHub: hub,
  port: 7433,
  token: tokenFromOwnerOnlyFile,
});
```

The caller remains responsible for creating admitted direct session hosts, closing `server`, closing `hub`, and closing `manager` in that order. The executable performs that lifecycle for the command-line case.

## Related guides

- [IPC](ipc.md) explains `/api/pi`, typed operations, package dispatch, and replay.
- [Lifecycle](lifecycle.md) explains when facets load and close.
- [Security](security.md) describes trusted package code and context capabilities.
