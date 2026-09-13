# Package APIs

A package API is server code contributed by a package in the active DoomPi composition. It gives a web plugin an HTTP-shaped boundary without putting filesystem access, process control, credentials, or long-running server resources in browser code.

The first design choice is placement. Run the handler in the process that owns the data.

## Two execution scopes

```text
Browser plugin
      |
      | /api/plugin/<basePath>
      v
DoomPi Web hub
      |
      +-- hub API --------------------> hub-owned machine or repository state
      |
      +-- session proxy over api.sock -> session API beside one agent
```

| Scope     | Runs in                 | Use it for                                                                        |
| --------- | ----------------------- | --------------------------------------------------------------------------------- |
| `hub`     | DoomPi Web process      | Repository discovery, machine settings, provider state, or work spanning sessions |
| `session` | `doompi-server` process | State and operations owned by one agent session or its working directory          |

A session API remains beside the agent even though the browser reaches it through the hub. The hub authenticates the browser, selects the session, and proxies the request over a Unix socket. Moving the handler into the hub would blur lifecycle and filesystem ownership.

Hub APIs have the opposite problem: a session ID alone is not authority to read an arbitrary repository. They use host-issued repository identities and resolvers instead of accepting browser filesystem paths.

## Routing model

All package APIs share one public prefix:

```text
/api/plugin/<basePath>/<package route>
```

The query selector chooses the execution scope and composition:

| Selector          | Destination                      | Composition used                                     |
| ----------------- | -------------------------------- | ---------------------------------------------------- |
| `session=<id>`    | That session server's API socket | Session APIs loaded when the server started          |
| `hubSession=<id>` | Hub process                      | Hub APIs from that session's selected web generation |
| none              | Hub process                      | Deterministic default hub API generation             |

The hub removes `session` or `hubSession` before calling the package handler. A request cannot contain both. That returns `400`. An unknown session, unavailable API, or missing selected generation returns `404`. A handler exception returns a generic `500` without stopping other APIs or the cockpit.

`hubSession` selects a composition. It does not make a hub handler session-scoped and does not add a `sessionId` to its context.

## Why APIs follow the composition

`doompi sync` discovers `doompiServer` declarations across the repository's configured candidate packages. It writes one `api/server.bundle.json` descriptor referencing independently compiled, generation-pinned facet modules.

The candidate list is not the active composition. Hosts filter scope and effective mode/layer ownership before importing facets or starting their handlers. A session-associated hub request uses that session's owning repository, pinned generation and effective selection, never another repository or newer sync defaults.

An empty composition still produces a valid descriptor. Optional package load failures are attributed and isolated; required failures prevent readiness. A malformed selected descriptor never silently falls back. Legacy route and facet aggregates are read only for explicitly admitted older generations, never generated or combined with a new descriptor.

See [Web bundling and serving](bundle.md) for generation selection and publication.

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

Use `hub`, `session`, or both scopes. Each package has one facet declaration with package-relative source and built paths that cannot escape the package. Publish its built entry and matching package export. Do not add a separate `doompiApi` field.

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

The host strips `/api/plugin/<basePath>` before calling `fetch`. A request to:

```text
/api/plugin/runner/runners/run-1/log
```

arrives at the `runner` handler as `/runners/run-1/log` with the original method, body, and ordinary headers.

## Host context

`DoomApiContext` identifies the execution scope and provides only host-owned capabilities relevant to that placement.

A session context may include the session ID, working directory, internal session credential, hub credential, and notice callback. These credentials are process capabilities for trusted package code. They are not automatically applied as route authorization and are never sent to the browser.

A hub context may include an opaque repository resolver and synchronized repository view. Use the resolver with a `repositoryId` issued by the hub. Do not reinterpret a path or repository ID from the request as authority.

## Caller identity and step-up

Before forwarding a browser request, the hub discards incoming copies of its trusted caller headers. It then stamps locality, paired-device identity when remote, and the result of any required passkey step-up.

A handler can read that context with `doomApiCallerFrom(request.headers)` from `@agimon-ai/doompi-core/package-api`.

This metadata answers who reached the handler and through which boundary. It does not replace operation-specific authorization. A package that writes credentials, starts processes, or opens new paths must still validate the request and enforce its own scope.

## Session request example

```text
GET /api/plugin/runner/runners/run-1/log?session=<session-id>
```

The hub classifies the caller as local or remote and authenticates a remote device. A local caller has passed the listener's Host and Origin policy but has no device identity. The hub removes `session`, stamps this trusted caller context, and forwards the request to that server's `api.sock`. The session server selects the `runner` handler and passes `/runners/run-1/log` to it. The browser never receives the session attach token.

A session server loads its API registry at startup. Build and run `doompi sync`, then restart the session when a session API changes.

## Hub request example

```text
GET /api/plugin/mcp/repository?repositoryId=<repository-id>&hubSession=<session-id>
```

The headless hub uses `hubSession` only to select the matching admitted server-facet generation. It removes the selector, then invokes the handler in the headless process. A hub module is built server code, so build and sync it before restarting the headless process.

## Failure and trust boundaries

Package APIs are trusted executable code, not remote sandboxes. Keep the failure boundary narrow:

- validate bodies, methods, identifiers, and content types before side effects
- bound file reads, response bodies, logs, and streams
- resolve paths against host-provided roots, never raw browser authority
- do not accept caller identity or authorization headers supplied by the browser
- make `close()` safe after partial startup
- report a package-scoped notice instead of taking down unrelated APIs

Remote requests still pass through the browser transport boundary, but that layer does not make a handler correct. See [Remote security](security.md).
