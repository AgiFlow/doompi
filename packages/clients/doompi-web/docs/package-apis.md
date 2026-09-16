# Package APIs

Package APIs are server facets from a synchronized DoomPi composition. DoomPi Web serves the browser and proxies API traffic to the headless listener. The headless process owns global, workspace, and session mounts and dispatches package requests in process.

## Routing model

| Scope     | Package prefix                                                           | Settings                                  | WebSocket                                                 |
| --------- | ------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------- |
| Global    | `/api/plugins/<package>`                                                 | `/api/settings`                           | `/api/ws`                                                 |
| Workspace | `/api/workspaces/<workspace-id>/plugins/<package>`                       | `/api/workspaces/<workspace-id>/settings` | `/api/workspaces/<workspace-id>/ws`                       |
| Session   | `/api/workspaces/<workspace-id>/sessions/<session-id>/plugins/<package>` | Not mounted                               | `/api/workspaces/<workspace-id>/sessions/<session-id>/ws` |

Scope comes from the path. Query parameters cannot select another mount. A session must belong to the workspace named in its path. Unknown workspaces, sessions, or package APIs return `404`, with no parent-scope fallback. Retired flat session routes and singular plugin routes have no compatibility aliases.

The global WebSocket carries the aggregate routed hub protocol. Workspace and session sockets restrict session attachments and package calls to their addressed scope. See the [protocol guide](../../../cli/doompi/docs/server/ipc.md).

## Synchronized compositions

`doompi sync` publishes a global generation and a workspace generation containing eligible workspace and session facets. Each generation includes `api/server.bundle.json` and pinned facet modules. Startup loads global facets; workspace admission loads that workspace's facets; session startup selects session facets from the owning workspace generation.

Hosts filter scope and mode/layer ownership before importing facets. Global and workspace defaults are independent; session composition follows its own selection. A missing or stale generation requires synchronization. A request never silently selects another repository or generation.

See [Web bundling and serving](bundle.md) for generation publication and [contract export](../../../cli/doompi/docs/server/api-export.md) for OpenAPI and AsyncAPI.

## Declare an API

Declare one server facet in the package manifest:

```json
{
  "doompiServer": {
    "entry": "./src/exports/extensions/server.ts",
    "dist": "./dist/extensions/server.mjs",
    "scopes": ["session"]
  }
}
```

Use `global`, `workspace`, `session`, or any combination of those scopes. Each package has one facet declaration with package-relative source and built paths that cannot escape the package. Publish its built entry and matching package export. Do not add a separate `doompiApi` field.

The built entry default-exports a Cordis object plugin. For example, re-export this adapter from `src/exports/extensions/server.ts`:

```ts
import {
  DOOM_SERVER_HOST_SERVICE,
  requireDoomServerHost,
  type DoomServerFacet,
} from '@agimon-ai/doompi-core/server-facet';
import { api } from '../exampleApi';

export default {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context) {
    const host = requireDoomServerHost(context);
    if (host.scope !== 'session') return;
    const registration = host.registerApi(api);
    return () => registration.dispose();
  },
} satisfies DoomServerFacet;
```

The API owns its base path. Eligible registrations compete for paths in deterministic installation order. Returning the disposer ties unmounting and handler cleanup to facet lifetime.

## Implement the handler

Keep the API implementation reusable, separate from the facet entry:

```ts
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-core/package-api';

export const api: DoomApi = {
  basePath: 'example',
  start(context: DoomApiContext): DoomApiHandler {
    return {
      async fetch(request) {
        return Response.json({ scope: context.scope });
      },
      close() {},
    };
  },
};
```

`start(context)` runs once when the host mounts that API. It returns a Fetch-compatible handler and `close()`. A Hono application can return `fetch: (request) => app.fetch(request)`. `close()` releases everything created by `start`, including timers, file watchers, streams, and child resources.

The host strips the complete scope and package prefix before calling `fetch`. A request to:

```text
/api/workspaces/<workspace-id>/sessions/<session-id>/plugins/runner/runners/run-1/log
```

arrives at the `runner` handler as `/runners/run-1/log` with the original method, body, and ordinary headers.

## Host context

`DoomApiContext` identifies the execution scope and provides only host-owned capabilities relevant to that placement.

A session context may include the session ID, working directory, internal session credential, hub credential, and notice callback. These credentials are process capabilities for trusted package code. They are not automatically applied as route authorization and are never sent to the browser.

A global or workspace context may include an opaque repository resolver and synchronized repository view. Use the resolver with a `repositoryId` issued by the hub. Do not reinterpret a path or repository ID from the request as authority.

## Authentication and caller context

The listener authenticates incoming requests. Remote sensitive operations additionally use the passkey step-up policy. Caller-supplied host, authorization, and trusted caller identity headers are stripped before package dispatch. Packages still validate their own bodies, file paths, and operations against the trusted `DoomApiContext`.

## Browser requests

Session URL builders use the shared web contract:

```ts
import { sessionApiPath } from '@agimon-ai/doompi-core/web';

const url = `${sessionApiPath(sessionId)}/plugins/runner/runners/${encodeURIComponent(runId)}/log`;
```

DoomPi Web binds the session-to-workspace lookup from its authoritative session summaries. Unknown ownership throws instead of constructing a route in another scope. Standalone browser hosts and test fixtures bind that lookup with `bindSessionApiWorkspace`.

A workspace request uses its admitted workspace ID directly:

```text
GET /api/workspaces/<workspace-id>/plugins/mcp/repository
```

The listener selects the exact mounted composition and invokes the handler with its package-relative path. Build, run `doompi sync`, and restart the owning runtime when server APIs change.

## Failure and trust boundaries

Package APIs are trusted executable code, not remote sandboxes. Keep the failure boundary narrow:

- validate bodies, methods, identifiers, and content types before side effects
- bound file reads, response bodies, logs, and streams
- resolve paths against host-provided roots, never raw browser authority
- do not accept caller identity or authorization headers supplied by the browser
- make `close()` safe after partial startup
- report a package-scoped notice instead of taking down unrelated APIs

Remote requests still pass through the browser transport boundary, but that layer does not make a handler correct. See [Remote security](security.md).
