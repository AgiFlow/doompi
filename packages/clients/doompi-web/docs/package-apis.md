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

`doompi sync` discovers `doompiApi` declarations from the same package roots used for the TUI and web plugins. It generates `hub.routes.mjs` and `session.routes.mjs` inside the immutable synchronized generation.

This keeps UI and server capabilities aligned. A plugin from repository A cannot silently borrow an API that exists only in repository B or in the global fallback. A session-associated hub request selects the complete generation already assigned to that session.

An empty API composition is valid and still produces both route modules. Missing metadata means a package contributes no API. Invalid optional declarations can be reported and skipped without removing unrelated packages.

See [Web bundling and serving](bundle.md) for generation selection and publication.

## Declare an API

Add `doompiApi` to the package manifest:

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

The field accepts one declaration or an array. `basePath` is kebab-case and must be unique among loaded APIs. A package may declare only `hub`, only `session`, or both.

Each scope names a package-relative source `entry` and built `dist` file. Paths cannot traverse outside the package. Sync uses the source entry to understand the build and the host imports the built module at runtime.

## Implement the handler

The built entry exports one `api` value:

```ts
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';

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

A handler can read that context with `doomApiCallerFrom(request.headers)` from `@agimon-ai/doompi-extension-contracts/package-api`.

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

The hub uses `hubSession` only to select the matching hub API generation. It removes the selector, then invokes the MCP handler in the hub process. Without `hubSession`, `DOOMPI_API_DIR` takes precedence, followed by the generated global API directory.

A hub module is built server code. Build and sync it before restarting or reloading the hub composition.

## Failure and trust boundaries

Package APIs are trusted executable code, not remote sandboxes. Keep the failure boundary narrow:

- validate bodies, methods, identifiers, and content types before side effects
- bound file reads, response bodies, logs, and streams
- resolve paths against host-provided roots, never raw browser authority
- do not accept caller identity or authorization headers supplied by the browser
- make `close()` safe after partial startup
- report a package-scoped notice instead of taking down unrelated APIs

Remote requests still pass through the web guard and sealed transport, but those layers do not make a handler correct. A direct browser `fetch` from a plugin may expose its payload to the tunnel relay unless it uses the sealed transport helper. See [Remote security](security.md).
