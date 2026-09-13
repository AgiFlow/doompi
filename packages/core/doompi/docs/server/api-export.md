# Export compiled client contracts

After syncing the global configuration and the workspace, run this in the workspace:

```sh
doompi api-export --out ./api-schema --strict
# Select a different session composition:
doompi api-export --out ./api-schema --major-mode copilot --strict
```

The command reads published generations. It does not sync, install packages, start servers, or import server facets. Stale or missing generations must be synced first. `doompi sync` outside a repository publishes the global composition; inside a repository it publishes that workspace.

The export contains:

- `openapi.json`: OpenAPI 3.1 HTTP operations, scoped plugin paths, request and response schemas, authentication, and named SSE payload schemas in `x-sse-events`.
- `asyncapi.json`: AsyncAPI 3.0 Pi envelopes, Chord calls, subscriptions and state deltas, session methods and reconstructed state, and selected extension methods and channel payloads. `x-doompi` identifies scope, service, member, direction through the operation action, and operation kind.
- `manifest.json`: selected global, workspace and session modes, generation IDs, composition fingerprints, package and protocol versions, explicit dynamic values, coverage gaps, and SHA-256 hashes of both documents.

The global and workspace scopes use their own default major modes. `--major-mode` changes only the session composition. Local WebSockets carry framed CBOR; remote WebSockets carry sealed envelopes around those bytes. Channel operations describe decoded payloads, not JSON WebSocket frames. The selected package's `service` and `member` identify plugin calls carried through `doompi.plugin.v1.invoke`.

Export with `--strict` in CI. An incomplete export is still written for review, but the command exits with status 1. Missing third-party declarations do not prevent normal sync. Dynamic tool, provider and author-capability values are listed explicitly; exporting a schema does not freeze runtime capabilities or prove a client compatible.

Compare committed artifacts for API drift, then validate actual client requests, server responses and decoded socket traffic against their operation schemas. Verify the document hashes before consuming a bundle, since the manifest is written last. The web client contract tests exercise real HTTP handlers; the core contract tests use the public Pi and Chord codecs and independent OpenAPI and AsyncAPI parsers.

## Declare a package contract

Add a separate data entry to the existing server metadata:

```json
{
  "doompiServer": {
    "entry": "./src/extensions/server.ts",
    "dist": "./dist/extensions/server.mjs",
    "scopes": ["session"],
    "contracts": {
      "entry": "./src/exports/apiContracts.ts",
      "dist": "./dist/api-contracts.mjs"
    }
  }
}
```

Build the contract as its own entry. Keep its graph free of handlers, lifecycle hooks, environment reads and service initialization. Declare every imported runtime dependency in `dependencies`, including `typebox` when using it. Undeclared imports can be accidentally bundled and behave differently after compilation.

```ts
import { defineApiContract } from '@agimon-ai/doompi-core/api-contracts';

export default defineApiContract({
  version: 1,
  http: [
    {
      id: 'status',
      scope: 'session',
      basePath: 'example',
      path: '/status',
      method: 'GET',
      authentication: 'owner',
      description: 'Read status.',
      responses: {
        '200': {
          description: 'Current status.',
          schema: {
            type: 'object',
            properties: { ready: { type: 'boolean' } },
            required: ['ready'],
          },
        },
      },
    },
  ],
  sockets: [],
  dynamic: [],
});
```

Source schemas use JSON Schema draft-07, including TypeBox output. The exporter namespaces local references and translates tuple keywords for OpenAPI 3.1. Use self-contained local references, without `$id` or remote references. An API-free facet should declare empty `http` and `sockets` arrays. Use `gaps` for known missing declarations; never use an unconstrained schema to hide missing coverage.
