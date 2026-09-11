# Migrations

The re-architecture behind DoomPi's kernel, its unified server facet, and the
agent mesh. This is the plan of record. What is left to do is in
[migrations_todo.md](./migrations_todo.md).

## History migration boundary

Existing v3 history is never implicitly upgraded during direct-host startup. Stop Pi and every writer first, then run `doompi history-import <v3-source> <v4-destination> --confirm-offline`. Import preserves a byte-exact original and publishes a distinct v4 journal while holding cooperative source and destination leases. Confirmation cannot prove that an unmanaged writer stopped; ambiguous locks are not automatically reclaimed.

If import or export reports an ambiguous lock, do not infer safety from the recorded PID and do not force a retry. Stop every managed and unmanaged writer, preserve and inspect the relevant `<history-path>.doompi-v4.lock` and migration state sidecars, and independently verify that the source and destination are quiescent. Only then archive or remove the stale lock explicitly and rerun the same command so it resumes from the retained state. If quiescence or file provenance cannot be proved, leave the lock and history files untouched for manual investigation.

Use `doompi history-export <v4-source> <v3-destination>` for a derived Pi-compatible fork and its machine-readable loss report. Resume the explicit file with pinned Pi 0.85.1's `pi --session <v3-destination>`, or select an export in the normal `/resume` discovery picker. `--resume <path>` is not that pinned CLI's path selector. Continuing the export never merges into canonical v4 history, and a modified continuation cannot be overwritten by re-export.

See the latest verification section in [migrations_todo.md](./migrations_todo.md) for evidence and remaining gates. This workflow does not authorize normal writable v4 cutover before those gates pass.

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
Phase 4 replaced the scope aggregate with independently compiled, generation-pinned
facet entries, so a broken package import no longer makes every facet in that
scope unavailable.

## 3. Agent mesh

`piHubService.ts` already makes the hub simultaneously a pi-protocol server to
clients and a pi-protocol client to each session, joined by a Chord
`RemoteServiceProvider`/`RemoteServiceEndpoint` re-publication.

The catalog allowlist and durable host-local enrollment are implemented, not
runtime-accepted. Peer transport and proxy integration are in progress. Explicit
pairing requires confirmed public-key fingerprints and per-agent grants, with
rotation and revocation. Peer credentials must not authorize human-device APIs.

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

## 4. Web and desktop

Web and desktop share the browser bundle and WebSocket carrier. Protocol
unification remains in scope. React Native and mobile-only client extraction were
explicitly removed by the user; no native application is required for completion.

Approved release targets are `darwin-arm64`, `linux-x64`, and `linux-arm64`.
Intel Mac and Windows are unsupported for this migration. Each supported target
still needs native acceptance evidence before release.

## Phases

| #   | Phase                                              | Requirement               | Current status                                                  |
| --- | -------------------------------------------------- | ------------------------- | --------------------------------------------------------------- |
| 0   | Tactical state-loss fix                            | keeps the product working | landed                                                          |
| 1   | `doompi-kernel` plus contribution registry         | 1                         | landed                                                          |
| 2   | Package remediation: lazy activation               | 1                         | landed                                                          |
| 3   | `./extensions/server`, pilot two, migrate the rest | 2                         | landed                                                          |
| 4   | `serverBundleSync`, delete `apiRoutesSync`         | 2                         | implemented, distribution pending                               |
| 5   | Harness-driven session server                      | **1 lands here**          | opt-in, acceptance pending                                      |
| 6   | Retire the standalone server package               | 2                         | removed at user request; core retains the executable            |
| 7   | Unified web/desktop client protocol                | 4                         | source integrated; runtime acceptance deferred; no React Native |
| 8   | Agent catalog and hub federation                   | 3                         | source integrated; default-disabled; acceptance deferred        |

Phase 5 contains the irreversible cutover because normal operation begins writing
Pi format 4 history. The format-3 export view must be accepted before that cutover.
Continue an explicit derived file with pinned Pi 0.85.1 using
`pi --session <v3-destination>`, or select it in `/resume`. Migration operates on a
verified copy and preserves the original v3 bytes. Opening the only original for a
writable upstream commit is forbidden.

The three Phase 4 prerequisites are closed: tool restrictions reconcile against
the host's active tools, rejected kernel sinks remain retryable, and packed-install
includes the kernel as a nonselectable core foundation. The remaining work and
acceptance evidence are tracked in [migrations_todo.md](./migrations_todo.md).

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

**One protocol includes extension presentation and hub events.** The cockpit now
routes typed controls, bounded presentation replay, and hub/plugin/thread events
over one Pi client connection. The explicit compatibility `/api/session` route
remains available, but the cockpit no longer opens it. Lifecycle regression and
runtime acceptance are still required before declaring feature parity.

**Federation reverses a deliberate security posture.** `hubAdvertisement.ts`
advertises loopback only and `remoteAccessStore.ts` deliberately persists no
device sessions. Hub-to-hub trust needs new durable credentials. `deviceAuth`
and `webauthn` authenticate a human; a peer hub is not a human. Explicit local
peer enrollment, a restart-fresh signed handshake, sealed protocol promotion, and
outgoing discovery/proxy source are implemented, including ordered native writes,
bounded queues, shutdown cancellation, and revocation cleanup. New regressions
remain unrun. Federation requires explicit `WebServerOptions.federation.enabled`;
normal launchers do not enable it. Static checks do not establish runtime acceptance.

## Implementation-first execution

The user requested remaining implementation before further test execution.
Architectural and static checks continue. Add focused regression coverage with each
change, but retain test execution and runtime acceptance as explicit outstanding
gates. Normal direct-host defaults remain blocked until those gates pass. The user
explicitly authorized immediate retirement of `packages/clients/doompi-server`:
core retains the executable, public server API, implementation, tests, and guides.
This package deletion does not enable writable v4 cutover. See the ledger for the
latest static evidence and deferred browser acceptance failure.

## Verification

Per phase, in order:

1. `pnpm vibe-lint check --rules-only <paths>` before editing governed files.
2. `pnpm exec oxfmt <changed paths>`.
3. `pnpm lint:vibe --preflight-only`.
4. The affected Nx `lint`, `typecheck`, `build` and `test` targets.
5. Packed-install system tests before any release change.

Use `scripts/run-clean-tests.mjs` for Nx and Vitest runs. Some subprocess tests
also require a clean `HOME`; do not combine that with macOS keychain tests.
