# Migration todo

This is the current execution ledger for [migrations.md](./migrations.md). It
replaces the older chronological checklist, which mixed superseded failures with
newer passes.

## Evidence labels

- **Implemented:** current source contains the behavior. This does not prove it ran.
- **Tests present:** current tests cover the behavior. This review did not run them.
- **Historically passed:** a prior run is recorded below. Reproduce it before release.
- **Accepted:** the release candidate passed the named gate and retained its evidence.
- **Blocked:** implementation or acceptance is still required.

## Earlier acceptance identity

- Verified at commit `1cd0f3b447617f10b9850634de9eb9c7edf60afb` with an uncommitted working tree.
- Verification time: `2026-09-10T15:26:39Z`.
- Verification platform: `darwin-arm64`.
- Scope: R1 and R2 acceptance, R3 direct-host and browser acceptance, local R4 distribution coverage, and affected regression gates.
- Retained evidence is stored under `~/.pi/doompi-migration-evidence/`. Results that exist only in temporary directories remain historical reports.

## Latest implementation verification

- Time: `2026-09-11T02:25:28Z`; platform: `darwin-arm64`; same HEAD above,
  with uncommitted changes. No branch, commit, release, or default-host cutover.
- Retained evidence: `~/.pi/doompi-migration-evidence/retirement-static-mtwbzfea-r4F8/`.
  Logs, retirement inspection, and the working-tree identity manifest are retained there.
- `mtwbzfea-r4F8`: 33 uncached Nx lint/typecheck/build tasks passed for contracts,
  core, web, desktop, sandbox, and build dependencies. Command:
  `node scripts/run-clean-tests.mjs pnpm nx run-many -t lint,typecheck,build -p @agimon-ai/doompi-extension-contracts @agimon-ai/doompi @agimon-ai/doompi-web @agimon-ai/doompi-desktop @agimon-ai/doompi-sandbox --skip-nx-cache`.
- Desktop staging was regenerated with
  `node scripts/run-clean-tests.mjs pnpm --filter @agimon-ai/doompi-desktop run build:runtime`.
  Its core-owned server artifact is present; the old staged package is absent.
  Cloudflared 2026.8.3 was staged for `darwin-arm64`. This is build evidence, not
  desktop launch or native acceptance evidence.
- `pnpm lint:vibe --preflight-only` and `git diff --check` passed. Static inventory
  found no live old-package references, excluding historical migration/changelog text.
  The Nx graph contains no old server project. Core publishes the retained server guides.
- Test execution, coverage measurement, packed-install, browser/desktop runtime,
  and supported-native acceptance remain deferred. The historical OAuth failure
  below remains unresolved; production federation remains default-disabled.

## Implementation-first scope update

The user requested implementation before further test execution. Architectural,
formatting, lint, typecheck, and build checks still apply. Test execution and
runtime acceptance are deferred, not waived. Normal writable cutover remains gated.
The user's later instruction explicitly authorized immediate old-server retirement,
independently of direct-host default cutover. That package has now been removed.

- Release targets: `darwin-arm64`, `linux-x64`, and `linux-arm64`.
- Intel Mac and Windows are unsupported in this migration.
- React Native and the mobile application are removed from scope, not postponed gates.
- Federation uses explicit host-local enrollment, confirmed peer key fingerprints,
  revocable credentials, and exact per-agent grants. No automatic or transitive trust.

## Current status

| Phase  | Status                            | Remaining gate                                                                           |
| ------ | --------------------------------- | ---------------------------------------------------------------------------------------- |
| 0 to 3 | Regression gates passed           | Re-run when affected.                                                                    |
| 4      | Local matrix passed               | Verify each approved release target natively.                                            |
| 5      | Acceptance open                   | Full web suite has an OAuth failure; production desktop live controls remain incomplete. |
| 6      | Old package removed               | Core owns server boundaries; normal direct-host cutover still awaits acceptance.         |
| 7      | Unified source integrated         | Execute authored lifecycle regressions and accept web/desktop parity.                    |
| 8      | Paired discovery/proxy integrated | Deferred security and runtime acceptance; production launch remains disabled.            |

Normal writable v4 cutover remains disabled. The direct host is still test-only
through `DOOMPI_TEST_DIRECT_HEADLESS=1`.

## Landed foundation

The following work is recorded as landed and is not reopened without a failing
regression:

- Phase 0 tactical state-loss fix.
- Phase 1 kernel and contribution registry.
- Phase 2 lazy-activation audit.
- Phase 3 server-facet contract, hosts, package migration, lint rule, scaffold,
  compatibility baseline, and browser path.
- Tool-surface reconciliation and retryable kernel application.
- Phase 4 `server.bundle.json` producer and descriptor consumers.
- Independently compiled, generation-pinned server-facet entries.
- Removal of `src/adapters/apiRoutesSync.ts` and legacy API authoring.
- Core ownership of the `doompi-server` executable.

## Historical verification

These results were reported by prior runs. They identify useful regression gates,
but they do not substitute for a release-candidate rerun.

- Core run `mtv7eioh-o3eN`: 112 files, 1,243 tests, 80.02% branch coverage.
- Later core run `mtv9o07q-_Nm7`: complete core lint, typecheck, build, test, and
  repository preflight passed. Its coverage percentage was not separately retained.
- Packed runs `mtv93zcy-Lutg` and `mtv9sp8r-DzZG`: four files, 359 tests passed,
  one skipped. The matrix contained 46 packages, not the required 49.
- Runner run `mtv9ks0p-sdKm`: complete runner native checks passed.
- Direct full-process run `mtv90sif-NrqD`: built host readiness, provider streaming,
  settled-entry persistence, authenticated socket state/history, and clean shutdown.
- Browser probes reported deterministic direct-harness turns, reconnect, history
  retention, major-mode tool removal/restoration, persona rereading, and survival of
  a supervised job. Their temporary evidence is no longer available.
- A pinned Pi 0.85.1 probe reported continuation of a derived v3 export using
  `pi --session <path>`. Exact path selection through `/resume` was not exercised.
- Native compiler execution was reported only on `darwin-arm64`.

## R1. Finish typed package execution behavior

**Owner areas**

- `packages/core/doompi-extension-contracts/src/schemas/headless.ts`
- `packages/core/doompi/src/adapters/server/headlessSessionHost.ts`
- `packages/core/doompi/src/adapters/server/directHarnessRuntime.ts`
- affected package headless facets and focused tests

**Implemented with tests present**

- Context transformation.
- Provider payload transformation at the upstream `before_payload` boundary, including
  ordered no-op composition, malformed-patch rejection, and subsequent recovery.
- Tool-call argument replacement and denial.
- Tool-result replacement and termination.
- Compaction decline and custom results at the upstream `before_compaction` boundary,
  including first-result semantics and malformed retained-tail rejection.
- Selection-driven tools, resources, commands, activities, and lifecycle observers.
- Event-specific provider, compaction, and model-selection contracts. Undeliverable
  `input` and tree-start events were removed rather than retained as silent no-ops.
- Headless autostop reads authoritative lane activity and cancels shutdown when new or
  queued work appears.
- Iterative autocompact remains an explicit Pi-only capability. Headless mode leaves native threshold compaction enabled and reports `native fallback` when configured. The pinned Pi 0.85.1 audit found completed-result substitution at `before_compaction`, but no supported deterministic checkpoint-generation boundary. The headless facet therefore neither registers a recursive structural hook nor calls `session.compact()`.

**Freshly verified**

- All 46 project typecheck targets pass.
- The complete 28-package `doompiServer` inventory passes its test targets through
  `scripts/run-clean-tests.mjs` with `--skip-nx-cache`; no package relies only on
  compilation or package-shape evidence.
- Core inventory, 10 of 10: `doompi` uses the `tests/unit/adapters/server/headless*`
  suites; autostop, config, domain, major-mode, notification, profile, skill, and UI
  use `tests/**/headlessFacet.test.ts`; cache uses
  `tests/unit/adapters/headlessFacet.test.ts`.
- Default inventory, 10 of 10: autocompact, edit, grep, hook, MCP, prompt, and read
  use `tests/**/headlessFacet.test.ts`; file-edit and runner use
  `tests/unit/adapters/serverFacet.test.ts`; log uses `tests/headless.test.ts` and
  `tests/unit/adapters/serverFacet.test.ts`.
- Minor inventory, 8 of 8: computer-use, goal, help, loop, and voice use
  `tests/**/headlessFacet.test.ts`; author and plan use
  `tests/unit/adapters/serverFacet.test.ts`; workflow uses
  `tests/unit/adapters/headlessFacetBehavior.test.ts` and
  `tests/unit/adapters/serverFacet.test.ts`.
- Direct execution found and fixed native ripgrep match-limit recognition and the
  workflow recovery resource's shipped path. Both fixes have regressions.
- `pnpm lint:vibe --preflight-only` and `git diff --check` pass.

**Acceptance status**

Accepted. Deterministic provider tests prove payload changes, tool denial and result
changes, compaction cancellation/customization, malformed-input rejection, and a
subsequent successful turn after each failure. The package inventory additionally
executes effective prompts, resources, tools, commands, activities, modes, and hooks.

## R2. Close protected-history acceptance

**Owner areas**

- `packages/core/doompi/src/adapters/serialization/`
- direct-runtime history tests
- history import/export CLI tests

**Verified acceptance evidence**

- Direct startup rejects v3 history and names the explicit offline import command.
- Cooperative source and destination leases reject ambiguous or replaced locks. Manual recovery is documented in [migrations.md](./migrations.md); locks are never reclaimed automatically.
- Process-level regressions send `SIGKILL` during staging and after destination publication, then prove stale-lock refusal, explicit cleanup, restart, repeated import, `published` or `already-published` recovery, exact source/original preservation, and valid v4 output.
- Protected import fidelity covers parent links, entry IDs, timestamps, labels, session metadata, content hashes, branch-tip proofs, unknown-record refusal, byte-exact originals, destination protection, and repeated import without canonical-byte changes.
- Derived v3 export preserves representable branch relationships and metadata, reports every unrepresentable or unknown record in a machine-readable loss report, protects canonical bytes, and refuses overwrite or unsafe resume after destination replacement.
- Native open preserves original or damaged bytes before upstream mutation. Storage failures quarantine later writes.
- Pinned Pi 0.85.1 continuation reopened the exact derived session with `pi --session <path>`. The separate interactive `/resume` picker discovered both retained fixtures, selected the target with keyboard input, and displayed its retained history and session name.

**Retained verification**

- Platform: macOS `darwin-arm64`; pinned `@earendil-works/pi-coding-agent` 0.85.1.
- `node scripts/run-clean-tests.mjs pnpm nx test @agimon-ai/doompi --skip-nx-cache --output-style=static`: passed with 87.60% statements and 80.19% branches.
- `pnpm nx run-many -t lint typecheck build -p @agimon-ai/doompi --skip-nx-cache --output-style=static`: passed.
- Process and native-check logs: `~/.pi/doompi-migration-evidence/r2-protected-history-20260910T142150Z/`.
- Continuation fixtures, RPC output, and TUI captures: `~/.pi/doompi-migration-evidence/r2-resume-20260910T140105Z/`.
- Known residual: a process killed after destination linking can leave the staging hardlink. Restart still validates the published bytes and reaches `already-published`; the retained regression does not conceal or delete that artifact.

**Acceptance status**

Accepted. Original v3 bytes and canonical v4 bytes remain exact when required, interrupted operations recover without overwriting foreign files, continued exports cannot be overwritten, and process evidence is retained outside temporary directories.

## R3. Accept all four live axes and client controls

**Owner areas**

- direct-host selection and composition publication
- major-mode, profile, domain, and minor-mode headless facets
- web session reducer and browser E2E
- desktop E2E

**Verified browser acceptance**

- The repository CLI, server entry, and web module were launched through explicit repository paths. This avoided the globally installed DoomPi fallback.
- Major mode, profile, domains, and Goal minor mode were switched separately and together. Provider context and the effective tool surface changed with the accepted selection.
- Cancelled and invalid selections, a failed Goal resource application, recovery, browser reconnect, direct-host restart, and selection restoration were exercised.
- Restart reopened the same journaled session ID and restored `MINIMAL`, `caveman`, the selected domains, active Goal state, notifications, and runner state. Existing journal entries replayed to the replacement socket once.
- A real supervised job survived live switches and emitted `R3_JOB_DONE`.
- Session removal withdrew its registry record, process, and control, event, and API sockets.
- Live failures found and fixed existing-session reopening, journal projection restoration, entry replay, and the Goal resource URL. Uncached core tests passed with 87.59% statements and 80.25% branches. The focused 15-test browser selection suite, desktop E2E target, and affected lint, typecheck, and build targets passed.
- Evidence: `~/.pi/doompi-migration-evidence/r3-live-controls-20260910T143000Z/`.

**Explained diagnostics**

- The cockpit's background sync of `~/.pi/.doom` rejected the user-local `ponytail` profile because that profile was not in the repository composition. The accepted session used the explicitly pre-synced repository bundle, and its live selection, provider context, tools, journal, sockets, restart, and cleanup remained operational.
- The supervised shell logged a missing optional `@agimon-ai/log-sink-mcp` telemetry sink. Telemetry initialization is deliberately warning-only and retryable, and `R3_JOB_DONE` proves the supervised job itself completed.

**Remaining gate**

- Complete the staged production desktop live-control run with an isolated home and a short runtime directory, then retain its screenshot, result, and startup log.
- Confirm the full web E2E target after the focused selection suite.

**Acceptance**

Browser acceptance is complete. R3 remains open until the production desktop run and full web E2E target complete without an unexplained relevant error.

## R4. Complete distribution coverage

**Owner areas**

- `packages/core/doompi/tests/system/packageMatrix.ts`
- compatibility fixtures and compiler/resource tests
- desktop runtime producer scripts
- CI and release workflows

**Verified local distribution evidence**

- The package matrix contains all 49 owned packages, including model guidance, Sandbox, and Git, with their exports, resources, and standard Pi entries.
- The focused identity run passed 49 checks. The expanded packed-install suite passed 320 tests with one native platform skip on `darwin-arm64`.
- Git and Sandbox now carry the required package keywords. Layer classification retains the distinct `ask-user` category while classifying the three added non-core packages as `layer`.
- Producer builds and desktop runtime staging passed. The staged desktop bundled cloudflared 2026.8.3 for `darwin-arm64`.
- Uncached affected lint, typecheck, and build targets passed. Repository Vibe-Lint preflight reported no violations.

**Blocked**

- Run native execution on `darwin-arm64`, `linux-x64`, and `linux-arm64`. Intel Mac and Windows are outside the approved release scope. Do not infer Linux results from macOS staging.
- Record commit, command, platform, result, coverage, and artifact location for each target.

**Acceptance**

The complete local package matrix and `darwin-arm64` staging pass. R4 remains open until every declared native target passes from a clean packed installation.

## R5. Enable direct-host operation and retire the old package

**Default cutover depends on:** R1 through R4. Package retirement was separately authorized by the user and is implemented.

**Owner areas**

- core server startup and launcher wiring
- web and desktop server producers
- package manifests, exports, compatibility fixtures, and release configuration

**Retirement implemented**

- Removed `packages/clients/doompi-server` and its Nx project. All its tracked
  source/test paths had corresponding core-owned paths before deletion.
- Core retains `doompi-server`, `@agimon-ai/doompi/server`, and the server tests.
  Six server guides now live under `packages/core/doompi/docs/server/`.
- Web resolves the executable from core; desktop stages core; sandbox installation
  needs web and its core dependency, not a separate server package.
- Offline lockfile regeneration removed only the old package's 55-line importer.
  Live package references were removed; historical changelogs remain unchanged.

**Default cutover and acceptance remain blocked**

- Audit normal launch arguments against the direct host's explicitly unsupported Pi
  flags before changing the default.
- Enable the direct host only after the Phase 5 acceptance gates pass.
- Keep v3 import explicit and offline. Never upgrade the original during startup.
- Repeat native, packed-install, browser, and desktop checks after default wiring and
  package removal.

**Acceptance**

A clean installation uses the direct host during normal operation and has no runtime
or development dependency on the old server package.

## R6. Eliminate the legacy client channel

**Implementation:** proceeds before R5 at the user's request. Acceptance still requires the normal-host baseline.

**Owner areas**

- `packages/core/doompi-extension-contracts/src/schemas/sessionProtocol.ts`
- session and hub protocol adapters
- web `transport.ts` and `sessionModel.ts`

**Implemented, not runtime-accepted**

- Typed session control/info contracts and hub forwarding now cover image-aware
  prompt/steer, follow-up, queue clearing, rewind, extension dialog replies, state,
  stats, commands, models, and supported thinking levels.
- The core adapter correlates replies by request ID and command, rejects pending
  calls on disposal or agent exit, and handles context cancellation. The direct
  host queries supported thinking levels through the public Pi API.
- Replay repair preserves genuinely new guarded status/widget updates and clears
  replay guards on disconnect, malformed backlog, and completion. Its effect on
  the previously failing OAuth browser scenario remains unverified.
- The cockpit uses one Pi client connection for typed controls, presentation,
  hub registry/plugin events, and thread traffic. `/api/session` remains an explicit
  compatibility endpoint, not a cockpit transport.
- Core presentation retains bounded live events and independent UI projections.
  Initialization hydrates persisted custom entries. Branch replacement carries a
  reset revision so rewind cannot preserve abandoned custom projections.
- Browser and server byte adapters serialize asynchronous work, bound buffered
  bytes, reject invalid sealed frames, and suppress duplicate terminal callbacks.
  Server writes have a deadline so a stalled peer cannot hold shutdown indefinitely.
- Uncached integrated contract/core/web/desktop/sandbox lint, typecheck, and builds
  passed in `mtwbwgkb-l8hZ` (33 tasks). Architectural preflight found no violations.
  These are static results, not runtime acceptance.

- Attachment cancellation and fixture initialization are integrated. Pending captures
  own background subscriptions independently of focus until completion, rejection,
  timeout, session removal, or socket loss. Replay cannot claim fresh execution.
  Corresponding capture/runtime regressions are authored but unrun.

**Deferred acceptance**

- Execute the authored regressions and browser/desktop acceptance when the
  test-execution deferral is lifted. Final static evidence is recorded below.
- Retire the compatibility endpoint only after parity is accepted.

**Acceptance**

All supported session behavior uses one protocol without a hidden second transport.

## R7. React Native removed from scope

The user explicitly removed the React Native task. Do not add an Expo project,
Metro configuration, native transport, or portable-client extraction solely for
mobile support. Web and desktop protocol unification remains in R6.

## R8. Deliver catalog and federation

**Implemented, not runtime-accepted**

- Versioned `/api/agents` allowlist projection: hub ID, agent ID, name, derived
  project label, creation time, and live status. No registry record spreading.
- Persisted owner-only Ed25519 hub identity and host-local enrollment routes.
- Confirmed public-key fingerprints, exact agent grants, explicit replacement,
  key rotation, and revocation in the store. Duplicate/self identities are rejected.
- Store writes use a lock, fsync, and atomic rename. Malformed state fails closed;
  ambiguous locks require manual recovery after confirming no writer is active.
- Signed key exchange now binds hello and welcome to a signed random server epoch,
  generated for each transport lifetime. Captured hellos are rejected after transport
  restart without persisting replay memory. Same-lifetime challenges remain one-use.
- The peer client verifies the pinned server before signing hello and rechecks local
  enrollment after each handshake response, not only before its first agent call.
- Sealed requests have bounded serialized queues, streamed response limits, redirect
  refusal, and fetch deadlines. Grant/key/origin changes and closure are rechecked
  before operations and before returning their results. Incoming local grants do
  not authorize this hub's outgoing remote agent IDs.
- Focused regressions include restart replay, epoch/signature tampering, handshake
  revocation, concurrent requests, in-flight revocation, and streamed size limits.
  All new federation regressions remain unexecuted.
- A dedicated sealed WebSocket promotes an authenticated peer session into the
  Pi protocol. The peer service grants only explicitly permitted local agents,
  denies session spawning, and never composes outgoing federation into its registry.
- The outgoing directory fetches only enrolled peers, validates minimized catalogs,
  exposes namespaced remote agent IDs, and uses the existing routed session service.
  Enrollment/grant changes invalidate cached discovery and active connections.
- Dedicated route composition requires explicit `federation.enabled`. Peer
  credentials do not authorize ordinary cockpit or administrative endpoints.
- Integrated static verification passed in `mtwbwgkb-l8hZ`. The failed federation
  worker did not supply an acceptance report; the source and retained static
  results were checked directly. No runtime or cross-platform acceptance is inferred.

- Native WebSocket callbacks now govern actual write completion, with bounded
  ordered queues, write deadlines, terminal cleanup, and shutdown rejection.
  Directory refreshes coalesce; cancellation and peer changes invalidate discovery
  and active clients. Protocol and directory regressions are authored but unrun.
- Source review confirms the minimized catalog boundary: no cwd, sockets, token
  paths, process IDs, or transitive peer metadata in published discovery.

**Deferred acceptance**

- Keep normal production federation disabled until deferred security, browser,
  and cross-platform acceptance passes.

**Acceptance**

Trusted hubs discover and access only permitted agents. Unauthorized and revoked
peers fail closed, restart/reconnect is deterministic, duplicate identities are
handled, and tests detect machine-local metadata leakage.

## Execution order

Implementation-first work proceeds in parallel on R6 protocol unification,
R8 paired federation, and supported desktop producers. R7 is removed.

Acceptance remains ordered: R1/R2, R3 live controls, R4 distribution/native targets,
then R5 normal direct-host cutover. Old-package retirement was separately authorized
and implemented. Run final protocol and federation acceptance after integration.
Code completion is not acceptance.

## Required verification for each implementation batch

1. `pnpm vibe-lint check --rules-only <paths>` before editing governed files.
2. `pnpm exec oxfmt <changed paths>`.
3. `pnpm lint:vibe --preflight-only`.
4. Affected Nx lint, typecheck, build, and test targets through
   `scripts/run-clean-tests.mjs`.
5. Packed-install system tests before release changes.
6. Retain runtime acceptance evidence separately from unit-test output.

## Environment notes

- `scripts/run-clean-tests.mjs` removes DoomPi and Pi agent environment variables and
  disables the Nx daemon.
- Build dependency producers before consumers. Do not run destructive producer builds
  concurrently with their consumers.
- Do not combine an isolated `HOME` with macOS keychain tests.
- The formatter is `oxfmt`.
- `pnpm vibe-lint check --rules-only` lists applicable rules; it is not the post-change
  architecture sweep.

## Latest deferred browser failure

Full serial run `mtw53aff-55uU` finished with 189 passed, one skipped, and one
failed OAuth test in `tests/e2e/context.spec.ts`. The trace shows the provider tab
opened, but the authorization dialog displayed connection failure rather than the
expected manual URL. The underlying cause is unverified. Preserve this regression;
do not label it a focus-only flake or a clean full-suite pass.

Background sync inheritance was separately fixed: compilation no longer inherits
`DOOMPI_PROFILE`, `DOOMPI_DOMAINS`, `DOOMPI_MAJOR_MODE`, or `DOOMPI_PRESET` from the
launching session. The valid repository `ponytail` profile was not removed.
