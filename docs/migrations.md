# Migrations

The re-architecture behind DoomPi's kernel, its unified server facet, and the
agent mesh. This is the plan of record. What is left to do is in
[migrations_todo.md](./migrations_todo.md).

## Why

Four hard requirements drive it.

1. **Hot reload on all four axes.** Changing minor mode, profile, domains or
   major mode must never hard-reload the agent. Today a major mode switch
   respawns the process and loses in-memory state, notably the active minor
   modes.
2. **The API and the server are one.** Two generators for the same surface is
   one too many.
3. **An agent mesh.** A hub advertises the agents it owns, ACP/A2A style.
4. **Web, desktop and native.** One protocol across all three carriers.

## 1. Hot reload without a hard reload

The mechanism is a static facet graph with gated contributions.

Sync compiles one server artefact containing the union of every layer across
every major mode, which `config.majorMode` already enumerates. The kernel
activates all facets once. Packages declare contributions to a kernel registry
tagged by owning layer instead of registering directly with a host. Any axis
change recomputes the active union and pushes it down.

| Axis       | Applied by                                                                  | Reload? |
| ---------- | --------------------------------------------------------------------------- | ------- |
| minor mode | contribution registry, already live today                                   | no      |
| profile    | `systemPrompt` closure re-read per turn                                     | no      |
| domains    | `setResources`                                                              | no      |
| major mode | recompute union, `setTools` + `setResources` + hook toggles + command table | no      |

This works because the harness setters are whole-list replacements, so removal
is inherent:

```ts
setTools(tools: AgentHarnessTool<TContext>[], context: Context): Promise<void>;
setResources(resources: Resources, context: Context): Promise<void>;
```

Chord's `FacetKernel` never adds or removes a facet, so its unbuilt
structural-replacement gap stops mattering.

**Honest limit.** Today's Pi `ExtensionAPI` has no removal for tools, commands
or `pi.on` handlers; packages fake inactivity with internal guards. Requirement
1 is only fully satisfied once the harness-driven server exists, in Phase 5. The
`./extensions/pi` facet keeps today's guard behaviour permanently, which is fine
because the TUI is a single-composition process.

## 2. The API and the server are one

`apiRoutesSync.ts` is deleted. One manifest field declares one
`./extensions/server` facet. `DoomApi` becomes an optional capability that facet
exposes. `serverBundleSync` replaces the generated `session.routes.mjs` and
`hub.routes.mjs` pair. The `session` and `hub` scopes survive as capability
metadata, not as separate facets.

### The server facet contract

A package ships two facets: the Pi extension the agent process installs, and the
server facet the headless host installs. The server facet is where the API is
registered, so the API and the server are one declaration.

```ts
export const runnerServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    if (host.scope !== 'session') return undefined;
    const registration = host.registerApi(api);
    return () => registration.dispose();
  },
};
```

The facet **must** be a Cordis object plugin, never a bare function that calls
`context.inject` inside itself. Only the object form declares its own `inject`,
so the host mounts one fiber and `fiber.await()` settles once `apply` has run. A
nested inject mounts a child fiber the host holds no handle on, and the host
reads the mount table to decide whether to open a listener at all. This was
verified with a throwaway probe test against Cordis 4.0.2, not inferred: an
object plugin settles `apply` before `fiber.await()` resolves, and the returned
function is honoured as a disposer on `root.fiber.dispose()`.

`doom-server-facet-shape` in `@agimon-ai/vibe-lint-plugin-doom-extension`
rejects the other forms. `scaffold-doom-server-facet` in
`templates/doom-extension` generates the correct one.

### Manifest declaration

```jsonc
{
  "exports": {
    "./extensions/server": {
      "types": "./dist/extensions/server.d.mts",
      "import": "./dist/extensions/server.mjs",
      "require": "./dist/extensions/server.cjs",
    },
  },
  "doompiServer": {
    "entry": "./src/exports/extensions/server.ts",
    "dist": "./dist/extensions/server.mjs",
    "scopes": ["session"],
  },
}
```

`scopes` defaults to both. A facet that does not declare a scope is left out of
that scope's generated module at sync time rather than checked for at install.

### Two levels of server, both loaded dynamically

There is no union of server surfaces. Only the SPA needs Vite to merge
compositions; server routes are `import()`ed at runtime from absolute file URLs,
so each composition keeps its own mount table.

| Level        | Selector                        | Where it runs                                                  | Where the modules come from                                                                                         |
| ------------ | ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| global / hub | no query, or `?hubSession=<id>` | the cockpit process                                            | that repository's synced generation, loaded per root when the root is admitted and disposed when no session uses it |
| session      | `?session=<id>`                 | that session's own server process, proxied over its API socket | the session repository's own synced generation                                                                      |

The hub keeps one `DoomServerHost` per composition bundle. A base path is only
unique within one composition, so a single shared table would let the first root
shadow the rest.

### Failure posture

Matches the API loader's. A missing module is ordinary state. A throwing facet
costs only its own surface and becomes a notice, never a host startup failure.
A broken static import is broader today: because each scope is one generated
aggregate module, it makes that scope's whole facet list unavailable. Phase 4
must replace that aggregate before load failures are isolated per package.

## 3. Agent mesh

Already 80 percent built. `piHubService.ts` makes the hub simultaneously a
pi-protocol server to clients and a pi-protocol client to each session, joined
by a Chord `RemoteServiceProvider`/`RemoteServiceEndpoint` re-publish.

Federation is that exact code pointed one level up: hub as client to a peer hub
instead of to a local Unix socket. The new work is the catalog and the trust
model, not the proxy.

```ts
interface CatalogEntry {
  version: 1;
  hubId: string; // new; SessionRecord has no notion of "whose"
  agentId: string; // SessionRecord.id
  name: string;
  project: string; // derived label, NOT cwd
  createdAt: string;
  status: 'live';
}
```

Never leaves the machine: `cwd`, `socketPath`, `tokenFile`, `apiSocketPath`,
`protocolSocketPath`, `pid`. Served at `/api/agents`, beside the `/api/health`
probe `hubProbe.ts` already trusts.

## 4. Web, desktop and native

One protocol, one carrier, already proven for two of three targets.

| Target  | Transport                                      | Status   |
| ------- | ---------------------------------------------- | -------- |
| web     | WebSocket, `binaryType='arraybuffer'`          | shipping |
| desktop | identical, loads the same bundle               | shipping |
| native  | same protocol, needs its own transport factory | new      |

The codec is portable by construction: `pi-protocol` depends only on
`@earendil-works/chord` and `typebox`, and the CBOR path touches only
`Uint8Array`, `DataView`, `TextEncoder` and `TextDecoder`. No `Buffer`
references. React Native needs a transport factory and app-lifecycle reconnect
hooks, not a protocol port.

## Phases

| #   | Phase                                              | Requirement               | Reversible |
| --- | -------------------------------------------------- | ------------------------- | ---------- |
| 0   | Tactical state-loss fix                            | keeps the product working | yes        |
| 1   | `doompi-kernel` plus contribution registry         | 1                         | yes        |
| 2   | Package remediation: lazy activation               | 1                         | yes        |
| 3   | `./extensions/server`, pilot two, migrate the rest | 2                         | yes        |
| 4   | `serverBundleSync`, delete `apiRoutesSync`         | 2                         | yes        |
| 5   | Harness-driven session server                      | **1 lands here**          | **no**     |
| 6   | Delete `doompi-server`                             | 2                         | yes        |
| 7   | Client core extraction, native transport           | 4                         | yes        |
| 8   | Agent catalog and hub federation                   | 3                         | yes        |

Phase 5 is the only irreversible phase: it flips the on-disk format to Pi format 4. The format-3 export view ships **in** Phase 5, not after, so `pi --resume`
works before the flip is permanent. Migration operates on a verified copy and preserves the original v3 bytes; opening the only original for a writable upstream commit is forbidden.

Before Phase 4 starts, three verified baseline defects must be closed: tool restrictions must reconcile against the host's actual active tools, a rejected kernel sink must remain retryable, and packed-install must include the kernel as a nonselectable core foundation.

## Costs that are not hidden

**Package remediation is real work.** Loading every facet means inactive
packages must do nothing. Phase 2 audited all 32 extension entries and found no
install-time side effect that blocks hot reload. The real blockers are `pi.on`
having no unsubscribe and `registerCommand` being unremovable, both of which
Phase 5 resolves.

**16 packages lose features on the server.** `ui.custom` has 24 sites across 16
packages and 18 packages import `pi-tui`. These stay TUI-only. The server host
surface omits `setWidget`, `editor` and `custom` entirely, so a miscall fails at
typecheck rather than silently no-opping.

**The legacy hub channel is not covered by "one protocol."** `transport.ts` and
`sessionModel.ts` carry dialogs, status, widgets, notifications, four custom
entry types and five response commands, none of it pi-protocol. Migrating it
onto `DoomSessionService` sits between Phase 5 and Phase 7.

**Federation reverses a deliberate security posture.** `hubAdvertisement.ts`
advertises loopback only and `remoteAccessStore.ts` deliberately persists no
device sessions. Hub-to-hub trust needs new durable credentials. `deviceAuth`
and `webauthn` authenticate a human; a peer hub is not a human.

## Open items needing a spike

1. React Native `WebSocket` binary framing on the chosen RN baseline. Cheap: a
   throwaway RN app echoing a CBOR frame.
2. `sealedProtocolSession` crypto portability to RN. Unread.
3. Chord's bundler emits CommonJS; Metro does not consume that the way Node
   does. Blocks a shared client facet, not the native client itself.

## Verification

Per phase, in order:

1. `pnpm vibe-lint check --rules-only <paths>` before editing governed files.
2. `pnpm exec oxfmt <changed paths>`.
3. `pnpm lint:vibe --preflight-only`.
4. The affected Nx `lint`, `typecheck`, `build` and `test` targets.
5. Packed-install system tests before any release change.

Use `scripts/run-clean-tests.mjs` for Nx and Vitest runs. Some subprocess tests
also require a clean `HOME`; do not combine that with macOS keychain tests.
