# Migration todo

What is left of the plan in [migrations.md](./migrations.md). Everything above
the line in "Landed" is verified by a run, not by reading source.

## Landed

- **Phase 0.** Tactical state-loss fix, verified live through the
  `DOOMPI_COMPOSITION_RECORD` chain.
- **Phase 1.** `packages/core/doompi-kernel`, `createDoomKernel({activeLayers})`.
  15 tests, 96.52% statements. Registered in `nx.json`,
  `scripts/audit-workspace.mjs` and `docs/features.md`.
- **Tool surface arbiter.** Session-scoped Cordis service in
  `doompi-extension-contracts`, the only writer of the host's active tool list.
  8 owner packages migrated. `no-direct-tool-activation` green across 147 files.
  `scaffold-doom-tool-restriction` locks the pattern into
  `templates/doom-extension`.
- **Phase 2.** Lazy-activation audit of all 32 extension entries complete. No
  install-time side effect blocks hot reload.
- **Phase 3 contract.** `DoomServerFacet`, `DoomServerHostService`,
  `declaredServerFacetsOf`, `orderServerFacets`, `createDoomServerHost`,
  `loadServerFacets`, `installServerFacets`. 30 unit tests.
- **Phase 3 hosts.** The session host (`serveSessionApis`) and the hub host
  (`mountHubApis`, one `DoomServerHost` per composition bundle) both install
  facets. 11 session unit tests, 13 hub integration tests.
- **Phase 3 sync.** `apiRoutesSync` also emits `<scope>.facets.mjs`;
  `syncCommand` reports the facet count.
- **Phase 3 pilots.** `doompi-runner` (session) and `doompi-git` (hub), each
  with a facet, an export barrel, a manifest block and a 4-case unit test.
- **Lockdown.** `scaffold-doom-server-facet` in `templates/doom-extension`
  generates the facet, the barrel and the test.
  `doom-server-facet-shape` in `@agimon-ai/vibe-lint-plugin-doom-extension`
  rejects a function facet, a missing `DOOM_SERVER_HOST_SERVICE` injection and
  an inject nested inside `apply`. 68 architecture tests, 156 plugin tests.
- **Dead union removed.** `resolveWebComposition` no longer writes a union api
  directory. It had no production caller: `served.apiDirectory` was already
  hardcoded `undefined` and the hub loads per-composition bundles. Composition
  cache version bumped to 4.

## Phase 3, remaining

### Migrate the 11 packages that still declare only `doompiApi`

Each needs a facet, an export barrel, a manifest `exports["./extensions/server"]`
entry, a top-level `doompiServer` block, a unit test from the scaffold, a
`vitest.config.ts` alias for `@agimon-ai/doompi-extension-contracts/server-facet`
where the package aliases contracts subpaths, and its contract or package-shape
test updated.

| Package | Scope | API adapter |
|---|---|---|
| `layers/team/doompi-team` | session | `src/adapters/teamCatalogApi.ts` |
| `packages/core/doompi` | session | `src/adapters/contextApi.ts` |
| `packages/default/doompi-file-edit` | session | `src/adapters/fileEditsApi.ts` |
| `packages/default/doompi-log` | hub | `src/adapters/hubApi.ts` |
| `packages/default/doompi-mcp` | hub | `src/adapters/web/mcpHubApi.ts`, exported as `mcpHubApi` |
| `packages/default/doompi-prompt` | hub | `src/adapters/hubApi.ts` |
| `packages/minor/doompi-author` | session | `src/adapters/authorApi.ts` |
| `packages/minor/doompi-computer-use` | session | `src/adapters/computerUseApi.ts` |
| `packages/minor/doompi-plan` | session | `src/adapters/planApi.ts` |
| `packages/minor/doompi-voice` | session | `src/adapters/voiceSessionApi.ts` |
| `packages/minor/doompi-workflow` | hub | `src/adapters/workflowHubApi.ts` |

If a package's `DoomApi` lives in `src/exports/` rather than an adapter, move the
implementation to `src/adapters/` with `git mv` and leave a forwarding barrel.
`doompi-git` is the worked example: importing `../../exports/hubApi.ts` from a
facet trips `boundary-import-allowlist`, `no-internal-public-import` and
`doom-layer-boundary` at once.

### Contract tests still owed

`doompi-server` and `doompi-web` have no compatibility baseline. Phase 3 is not
closed until both have one.

## Phase 4

- Write `serverBundleSync`, replacing the generated `session.routes.mjs` and
  `hub.routes.mjs` pair.
- Delete `packages/core/doompi/src/adapters/apiRoutesSync.ts` and its test.
- Update the consumers: `doompi-web/src/adapters/webComposition.ts`,
  `doompi-extension-contracts/tests/packageApi.test.ts`, and the desktop copies
  under `packages/clients/doompi-desktop/build/runtime/` and
  `packages/clients/doompi-desktop/build/hub/`.

## Phase 5, irreversible

- Drive `@earendil-works/pi-agent-core` `AgentHarness` directly from the session
  server.
- Flip the on-disk format to Pi format 4, and ship the lossy format-3 export
  view in the same phase so `pi --resume` keeps working.
- This is where requirement 1 actually lands: `setTools`, `setResources`, hook
  toggles and a replaceable command table.
- The headless host surface must omit `setWidget`, `editor` and `custom` so a
  miscall fails at typecheck.

## Phase 6

- Delete the `packages/clients/doompi-server` package. The role survives; the
  package does not.

## Phase 7

- Extract the client core and add a React Native transport factory plus
  app-lifecycle reconnect hooks.
- Between Phase 5 and here: migrate the legacy hub channel (`transport.ts`,
  `sessionModel.ts`) onto `DoomSessionService`. Currently unscoped.

## Phase 8

- Agent catalog at `/api/agents`.
- Hub-to-hub federation, including the durable peer credentials that
  `deviceAuth` and `webauthn` do not provide.

## Known gaps

- Session-scoped tool surface behaviour across `pi-reload` is untested.
- `cordis.inject` async resolution is verified in tests, unverified in the real
  Pi host.
- 9 unguarded `pi.on` handlers are classified safe only because they live in
  always-on core packages.
- React Native WebSocket binary framing, `sealedProtocolSession` crypto
  portability and Chord's CJS bundle under Metro all need a spike.

## Environment notes for anyone picking this up

- Nx and vitest runs need `env -u DOOMPI_AGENT_COMMAND -u DOOMPI_CORDIS_HOST_REQUIRED`.
- A single vitest file needs `--coverage.enabled=false`; the global threshold is 80%.
- The formatter is `oxfmt`, not biome.
- `vibe-lint` is only on PATH under `pnpm`. Use `pnpm lint:vibe --preflight-only`.
  `--rules-only` lists governing rules, it does not check.
- `git stash` baselines are unreliable because gitignored `dist/` survives. Use
  `HOME=$(mktemp -d)` instead.
- Known env-sensitive tests:
  `doompi-server/tests/unit/adapters/doomAgentLauncher.test.ts`,
  `packages/core/doompi/tests/adapters/launcherLoadPlan.test.ts`,
  `doompi-web/tests/unit/serveHelp.test.ts`,
  `doompi-web/tests/integration/bridge.test.ts` and `tunnelProcess.test.ts`, and
  the `doompi-config` suite. All pass under a clean `HOME`.
