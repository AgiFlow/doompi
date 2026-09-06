# Package APIs

A DoomPi package can expose HTTP handlers through `doompiApi` in `package.json`. The generated route modules are part of the synchronized composition. The package entry exports one named `api` value implementing the `DoomApi` contract.

## Manifest

```json
{
  "doompiApi": {
    "basePath": "example",
    "session": {
      "entry": "./src/exports/sessionApi.ts",
      "dist": "./dist/sessionApi.mjs"
    },
    "hub": {
      "entry": "./src/exports/hubApi.ts",
      "dist": "./dist/hubApi.mjs"
    }
  }
}
```

The field may contain one object or an array of objects. `basePath` is kebab-case and globally unique among loaded APIs. Each declared entry has a package-relative source `entry` and a built `dist` path. The host imports the built entry, not source code.

A package can declare only `session`, only `hub`, or both. Missing metadata means that the package has no package API. Malformed metadata or an unavailable entry is reported and skipped when it can be isolated.

## API implementation

The entry exports `api` with a mount name and a `start` factory:

```ts
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';

export const api: DoomApi = {
  basePath: 'example',
  start(context: DoomApiContext): DoomApiHandler {
    return {
      async fetch(request) {
        return new Response(JSON.stringify({ scope: context.scope }), {
          headers: { 'content-type': 'application/json' },
        });
      },
      close() {},
    };
  },
};
```

Routes are relative to the API mount. For a Hono application, return `fetch: (request) => app.fetch(request)`. `close()` must release any timers, watchers, streams, or other resources created by `start`.

`DoomApiContext` includes the API scope, and session APIs receive the session ID, working directory, and session-only internal credentials as applicable. Hub APIs can receive an opaque repository resolver and synchronized repository view. Use the resolver with a hub-issued `repositoryId`; do not accept a browser filesystem path as authority.

## Request routing

The public prefix is `/api/plugin/<basePath>`. The hub strips that prefix before invoking the handler.

### Session APIs

A session API is mounted in the session server and reached through the hub's Unix-socket proxy:

```text
GET /api/plugin/runner/runners/run-1/log?session=<session-id>
```

The hub removes `session` before forwarding the request, so the handler receives a relative path and no session selector. The session server owns session data and its package API socket. The browser does not receive the session attach token.

The hub stamps the proxy request with the caller locality, paired device ID when remote, and step-up result. A session API that needs this identity can use `doomApiCallerFrom(request.headers)` from `@agimon-ai/doompi-extension-contracts/package-api`. Incoming copies of those headers are discarded before the hub writes the trusted values.

### Hub APIs

A hub API runs in the cockpit hub. Add `hubSession=<session-id>` when the request must use the hub API bundle selected for a session:

```text
GET /api/plugin/mcp/repository?repositoryId=<repository-id>&hubSession=<session-id>
```

`hubSession` selects the session-associated bundle. It does not turn the API into a session-scoped handler or supply `sessionId` in its `DoomApiContext`. The hub removes the selector before calling the handler.

Without `hubSession`, the hub uses its deterministic default API bundle. `DOOMPI_API_DIR` takes precedence when set. Otherwise the default is the generated global API directory, normally `~/.doompi/api/current`.

A request cannot include both `session` and `hubSession`; the hub returns `400`. An unknown session bundle or missing API returns `404`. An API exception is isolated to that API and returns `500` rather than stopping the cockpit.

## Composition and synchronization

`doompi sync` discovers `doompiApi` declarations from the resolved package roots and writes `hub.routes.mjs` and `session.routes.mjs` in the generated API directory. An empty API composition still produces both modules. The hub loads hub entries for the selected composition and session servers load session entries when they start.

Session composition follows the repository-first, global-fallback rule in [bundle resolution](bundle.md). A session's `hubSession` request cannot borrow an API from a different registration. Restart a session after synchronization when its server-side API entry changed.

## Security requirements for handlers

A package API is executable server code. Validate request bodies, bound reads and streams, and keep file paths inside the intended scope. Use opaque repository IDs and host-provided context instead of trusting paths or authorization headers from the browser. Remote requests pass through the host guard and, except for direct pairing and socket routes, the sealed HTTP gateway. See [remote security](security.md).
