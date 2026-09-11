# Canonical cutover acceptance ledger

This ledger records verified evidence and unresolved gates for [migrations.md](./migrations.md). Source presence is not runtime evidence. A gate is accepted only when the named command or scenario has passed and its result is retained.

## Current implementation status

The canonical three-surface implementation is present:

- Pi terminal packages publish `./extensions/pi`.
- Browser plugins publish only `doompiWeb.client` and remain presentation-only.
- Server packages publish `./extensions/server` through `doompiServer`.
- The client-neutral headless process owns the hub, sessions, native children, APIs, security, history, bounded replay, and presentation events.
- Native Team children use direct typed services and in-process lifecycle projection.
- Explicit Claude and Codex runtimes remain external subprocesses without automatic fallback.
- Server composition loads only generation-pinned `server.bundle.json` descriptors.
- The authenticated browser protocol endpoint is `/api/pi`.
- Web proxies `/api` and `/api/pi`; desktop starts explicit headless and presentation roles.
- The old standalone server package and obsolete headless export wrappers are removed.

Normal release acceptance is still open. Do not infer release readiness from source completion.

## Verified in the current working tree

### Core runtime

- Uncached core lint, typecheck, build, and test targets passed.
- Core test result: 109 files and 1,219 tests passed.
- Coverage: 86.89 percent statements, 80.08 percent branches (5,556 of 6,938), 89.92 percent functions, and 90.30 percent lines.
- Focused tests cover admission versus settlement, authentication, ownership gates, isolation, bounded replay, malformed controls, hydration, fork rollback, API failures, cleanup failures, and session-scoped native children.
- Protected v3 and v4 history tests cover explicit offline import, byte preservation, leases, interrupted publication, export loss reports, and refusal to overwrite modified continuations.

### Package and extension contracts

- Extension-contract lint, typecheck, build, and tests passed uncached.
- Descriptor loading rejects missing or malformed `server.bundle.json` and ignores forbidden aggregate module candidates.
- Compatibility and source-layout system tests passed: 61 tests.
- The compatibility fixture reflects current manifests and no longer freezes removed headless exports.
- Repository sweeps found no live retired package export, aggregate loader, internal session bridge, or filesystem-discovery reference. Remaining matches are explicit rejection tests, 404 assertions, or unrelated sandbox broker and runner lifeline facilities.

### Team and typed package services

- Native Team unit tests, typecheck, lint, and build passed.
- Author, Voice, and computer-use focused tests and typechecks passed with injected typed services.
- Unsupported native child configuration and unavailable typed hosts fail explicitly.

### Web and desktop

- Web lint and typecheck passed.
- Web Vitest result: 68 files and 629 tests passed.
- The web build now passes uncached after rebuilding its dependencies.
- Desktop package lint, typecheck, build, tests, E2E, and Vibe checks passed.
- Desktop startup stages the core headless executable and the presentation-only web process.

### Repository checks

- `pnpm lint:vibe --preflight-only` passed across 3,416 package files before the latest acceptance edits.
- `git diff --check` passed before the latest acceptance edits.
- Server architecture guides and the `doom-web` scaffold describe the canonical ownership split.
- The scaffold catalog parses and its include inventory has no missing files.

## History boundary

Protected-history acceptance is retained as complete for the current implementation. Normal startup must never upgrade v3 history. Import stays explicit, offline, and lease-protected. Export produces a derived v3 file and a machine-readable loss report.

A known residual remains documented: a process killed after destination linking can leave a staging hardlink. Restart validates the published bytes and reaches the already-published result without hiding or deleting that artifact.

## Open acceptance gates

### Browser runtime

- Complete the full Playwright target against the authenticated headless `/api/pi` stand-in.
- Confirm login, reconnect, replay ordering, session isolation, controls, package presentation, and retired endpoint rejection.
- Preserve the command, result, browser artifacts, and relevant server logs.

The earlier browser build blocker was traced to missing compiled server entries in package output. The cache server entry has been restored to its build configuration. Full Playwright execution is being rerun and is not yet accepted in this ledger.

### Security and federation

- Reproduce and resolve the existing OAuth failure.
- Exercise sealing, replay rejection, revocation, queue bounds, write deadlines, and shutdown cancellation.
- Confirm peer credentials cannot create sessions or reach human-device APIs.
- Keep federation default-disabled until these scenarios pass.

### Terminal and native Team parity

- Exercise terminal and headless native children through equivalent prompt, tool, lifecycle, cancellation, and journal scenarios.
- Confirm every child journal is separate and preserved according to policy.
- Confirm unsupported native configuration never selects a spawned Pi fallback.
- Exercise explicit Claude and Codex runtimes as external subprocesses.

### Desktop runtime

- Run a staged production desktop instance with an isolated home.
- Verify authenticated headless startup, presentation proxying, live controls, reconnect, typed computer-use IPC, and bounded shutdown.
- Retain screenshots, process logs, and results.

### Packed consumers and platforms

- Run the complete packed-install system suite after the final manifest and build changes.
- Confirm a clean consumer resolves every declared server, Pi, and web artifact without workspace source access.
- Run native execution on `darwin-arm64`, `linux-x64`, and `linux-arm64`.
- Record commit identity, command, platform, coverage, and artifact location for every approved target.

Intel Mac and Windows are not approved release targets for this cutover.

### Efficiency

- Measure idle headless memory and process count without web dependencies.
- Measure native child startup and cleanup latency.
- Confirm event replay and pending-operation storage remain bounded under sustained use.
- Compare the result with the pre-cutover baseline and retain the measurement method.

## Final command gates

Run these after the remaining implementation and runtime changes:

1. Repository-native formatting for every changed file.
2. `pnpm lint:vibe --preflight-only`.
3. Sequential uncached affected Nx lint targets.
4. Sequential uncached affected Nx typecheck targets.
5. Sequential uncached affected Nx build targets.
6. Sequential uncached affected Nx test targets.
7. Packed-install system tests.
8. Full web Playwright and staged desktop E2E.
9. `git diff --check`.

Do not lower coverage thresholds, restore compatibility wrappers, or add an alternate host to make a gate pass. Fix the canonical path or record the gate as blocked.
