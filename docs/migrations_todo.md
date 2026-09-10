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

- **Phase 3 package migration.** All 11 former `doompiApi`-only packages now
  publish a scope-gated `./extensions/server` facet while retaining their legacy
  declarations. Their 44 facet cases pass, all 11 built ESM, CJS and declaration
  targets exist, and every built default facet imports successfully.
- **Phase 3 host baselines.** `doompi-server` and `doompi-web` now freeze their
  package entry surfaces and exercise facet-only routing, legacy-first dual
  registration, throwing-facet isolation, handler failure isolation, scope
  context and disposal. Their full suites pass with 142 and 1,499 tests.
- **Phase 3 generated path.** A sync smoke test loads, installs and disposes a
  generated facet beside its legacy route. The compatibility baseline passes 49
  cases and includes all new server exports.
- **Phase 3 browser path.** The native Chromium E2E suite passes 190 cases with one
  skip. An isolated built cockpit also created a real repository session, reached
  the session-scoped context API through the hub, and removed the session record
  and all three session sockets through the browser UI. Hub and session logs show
  facets yielding to the retained legacy first owner.

## Prerequisite baseline repairs, landed

- **Tool surface reconciliation.** The arbiter now reads the host's active list,
  removes newly auto-activated denied tools, repairs external resets and retries a
  failed setter without caching it as applied. Its focused suite passes 14 cases.
  Attribution of every tool in the reported screenshot remains a runtime gate.
- **Kernel retry recovery.** The serialized queue recovers after rejection and caches
  only acknowledged sink applications. Its 17 cases cover same-selection recovery
  and a later queued switch after failure.
- **Packed-install closure.** Kernel is now a nonselectable core foundation in the
  owned package inventory, which asserts every owned `workspace:*` runtime edge has
  a tarball. The compatibility baseline passes 50 cases and packed installation
  passes 299 cases with one skip.

## Phase 4

- **Producer and transitional consumers verified.** Fresh sync writes one versioned
  `server.bundle.json` with independently compiled, generation-pinned modules.
  State/registration linkage and compiler receipts detect descriptor, dependency,
  declaration and artifact drift. Failed publication preserves the old registration.
  The focused producer group passes 90 tests. Both consumers enforce pre-import
  eligibility, generation/root confinement and explicit legacy admission without
  fallback. Their complete native gates passed: web 1,508 tests and server 143.
- **Obsolete authoring removed.** Deleted `src/adapters/apiRoutesSync.ts` and its
  tests; retained read-only compatibility filename helpers. All 13 owned API
  manifests now declare only `doompiServer`. Templates and lint rules reject
  legacy authoring; useful API exports remain. The declaration test helper validates
  API shape and declared scope, not actual facet registration. Facet lifecycle tests
  separately cover registration and disposal. Focused contracts tests pass 29 cases;
  full contracts, 12 non-core API owners and tooling native gates pass
  (`mtumxi9u-4xd3`, `mtumxxwl-btXE`).
- **Final core acceptance pending.** Latest full core tests pass 1,108 cases and
  fail three (`mtuv33p4-JwgY`): two bundle/compiler tests reject the newly reached
  native `@tursodatabase/database` dependency, and native-v4 metadata export loses
  session-info/label expectations without protected-import provenance. These are
  migration defects, not external registry blockers. Earlier passes do not establish
  current acceptance; no coverage threshold reductions or exclusions are permitted.
- Regenerate desktop staging through its producers during the distribution cutover,
  not by hand-editing ignored `build/runtime/` or `build/hub/` outputs.

## Phase 5, gated on protected history

- **Checkpoint, not production cutover.** Core owns copied session-host sources and
  a direct `AgentHarness` adapter behind `DOOMPI_TEST_DIRECT_HEADLESS=1`. Normal
  sessions still use the RPC host; the retired server package still exists. The
  pinned `pi-agent-core` dependency does not authorize normal v4 writes.
- **Focused host evidence.** Fifteen runtime, host, startup and client tests pass,
  including actual deterministic-provider tool removal/restoration, resource
  re-reading, prompt-hook composition, failed preparation recovery and shutdown
  (`mtuti43t-r5-d`). This does not prove executable/socket/browser parity or all
  four selection axes.
- **Recovered package checkpoints.** Config, profile, domain and major-mode pass
  lint, typecheck, build and full tests (`mtutxp10-gGqL`). Profile tests cover a
  synthetic env secret, selected persona re-reading and unknown-profile rejection.
  Raw config notification paths were removed. Runner and Task pass the same native
  gates with unchanged coverage thresholds (`mtuuh084-rBpP`); five added headless
  bash tests cover ownership, streaming modes, timeout and pre-aborted dispatch.
  Mocked retained-activity tests are not real running-job acceptance.
- **Checkpoint gates remain distinct.** Full history recovery, real Pi resume,
  combined live selection, browser/desktop, packed installation and package
  retirement remain outstanding. Existing focused passes do not satisfy them.
- Ship protected-copy import, interruption recovery and resumable v3 export before
  enabling normal v4 writes. Preserve every v3-representable record and branch;
  disclose nonrepresentable v4 data in a machine-readable report while retaining
  canonical data. Pi continuation is a separate history, never a second writer.
- **Isolated upstream probes passed.** On pinned 0.85.1, intact v3 open preserves
  source bytes but remints retained entry IDs and projects labels/session metadata
  into values. The first mutation upgrades that same path to v4. Opening a torn v4
  journal rewrites its tail. Preserve original and damaged bytes before upstream
  open, not merely before the first explicit commit.
- **Write-failure containment is required.** An injected partial ENOSPC rejects
  without changing in-memory state. Immediate close/reopen recovers the intact
  prefix. A subsequent accepted commit before close causes the next reopen to fail
  with invalid JSONL. Block further writes after storage failure, preserve the
  journal, and recover under exclusive ownership. These are temporary-root public
  API probes, not completed production safeguards or real Pi resume evidence.
- **History drafts are not accepted.** Review identified destructive exclusive-write
  `EEXIST` cleanup, incomplete import-proof and resumable-state validation, export
  ownership races, and unproven branch/unknown-record fidelity. Implementation and
  full failure/restart coverage remain required. Normal v4 writes stay disabled.
- Implement live tools, resources, prompt sources, hooks, commands, client actions
  and optional activity through typed headless contributions. The headless surface
  must reject `setWidget`, `editor` and `custom` at typecheck.
- **Source inventory complete, behavior still unverified.** The packing matrix
  covers 46 packages; a deterministic manifest scan identified three omitted
  selectable layers: model-guidance, sandbox and git. Their contributions are also
  inventoried. Include all 49 in migration coverage, preserve unrelated
  model-guidance edits, and close matrix/baseline gaps during distribution work.

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
- Legacy scope aggregates remain only for explicitly admitted older generations.
  New descriptor consumers and obsolete authoring removal are implemented and
  tested; final core acceptance is blocked by unfinished history draft gates.
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
