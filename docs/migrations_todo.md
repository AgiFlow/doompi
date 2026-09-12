# Canonical cutover acceptance ledger

This ledger records verified evidence and unresolved gates for [migrations.md](./migrations.md). Source presence is not runtime evidence. A gate is accepted only when the named command or scenario has passed and its result is retained.

## Author and remote settings checkpoint (2026-09-12)

- Verified: The Author headless prompt reader now locates `src/prompts/doompi-use-author/SKILL.md` from both source and the nested compiled module layout. The focused test passed. Uncached Author lint, typecheck, build, and test targets passed.
- Verified: A fresh isolated backend on port 7467 and browser on port 7465 activated Author. The Author chip became active, a subsequent Profile dialog opened, and the backend logged no Author resource failure. The 7447 process was left running so its current session was not interrupted.
- Verified: `GET /api/remote` returned 404 through the isolated web bridge. The browser now shows that error and a retry action instead of an endless Remote Control settings spinner.
- Verified: Uncached web lint, typecheck, and build passed, and all 625 web tests passed. The aggregate web test target remains red because branch coverage is 78.6 percent against its 80 percent gate.
- Open: The `/api/remote` control plane is absent from the current headless server. Remote settings, tunnel setup, pairing, and device controls remain unverified and unavailable in this isolated cutover. Author activation in the existing 7445 session still uses its previously mounted generation until that session can be replaced or hot-reloaded.

## Command selection checkpoint (2026-09-12)

- Verified: The server wrapper no longer waits for an agent settlement frame after a handled slash command. The focused runtime test passed 13 assertions, including consecutive commands with and without telemetry. Uncached core lint, typecheck, and build passed.
- Verified: A fresh isolated backend on port 7457 and browser on port 7455 activated Plan through its Normal flavor picker, changed Profile from Ponytail to Caveman, deactivated Plan, and activated Help. Help and Caveman remained selected after browser refresh. The earlier cockpit ports were not restarted.
- Verified: The uncached MCP lint, typecheck, build, and test targets passed after accepting the current worktree repository ID in the workspace MCP route. The focused MCP route tests passed 17 assertions.
- Open: The most recent packed-install system run passed 379 tests, skipped 1, and failed 3 among 383. Two failures occurred during sync, with one reporting a missing compiled `mcpSession.mjs` while parallel builds were replacing outputs. The first failed during `sync --check`. Packed-install approval remains open pending a clean rerun and diagnosis.
- Open: The uncached full core test target passed 813 tests, skipped 27, and failed 5 across the existing harness-options, extension-compiler, server-facet, and terminal-child fixtures. Browser Playwright, staged desktop E2E, and long-conversation load checks remain to be completed. The isolated 7445 cockpit still runs the older backend process; use port 7455 for this command fix until that process is restarted.

## SQLite transcript checkpoint (2026-09-12)

This checkpoint supersedes the older test counts below for the current uncommitted SQLite transcript change.

- Verified: Server root journals and native server child journals use SQLite. The focused storage tests passed for two live harness turns, ordered settlement markers, active child reads, completed child reads, and indexed page reads at 1,000, 10,000, and 100,000 entries. Explicit v3-to-SQLite import tests passed. Browser cache tests passed for bidirectional paging and bounded retention.
- Verified: In an isolated Doom home, forced checkout-scoped sync published a fresh generation. The headless process on port 7447 created a session, answered a browser prompt on port 7445, and restored the prompt, response, settlement marker, profile label, context, and cost after refresh. Its journal contains eight SQLite entries. The other cockpit ports were not used.
- Verified: Log Sink received `doompi_server.transcript_page`, `web.browser.transcript_page`, `web.browser.transcript_render`, and prompt latency events for this session. The refreshed eight-entry page read took 0.91 ms on the server; its browser page fetch took 13 ms and render took 1 ms. These are one isolated smoke run, not a sustained-load benchmark.
- Verified: `pnpm lint:vibe --preflight-only` passed across 3,155 files. The uncached core and web builds passed after the paging-store move. These results predate the final cleanup and do not close the final gates.
- Open: Rerun affected lint, typecheck, build, and full test targets after final edits. Run packed-install system tests and the full browser/desktop acceptance flows. Measure sustained long-conversation behavior and recoverability, including cursor paging after process restart. Automatic replacement of mounted server generations remains open.

## Three-level scope checkpoint (2026-09-12)

The evidence below supersedes older passing results in this file for the current uncommitted three-level change. Older results describe an earlier checkout and do not approve this change for release.

- Verified: An isolated Doom home under a temporary directory completed `init`, `sync --global`, and repository `sync` using this checkout. Its headless server ran on port 7447, separate from the other cockpit. The global config and images APIs responded, the global provider API returned 40 providers, workspace admission succeeded, and `POST /api/sessions` created a root session in that workspace.
- Verified: The browser on port 7445 displayed providers, repository defaults, and inherited planning settings. After the WebSocket summary correction, the session displayed its agents, runners, git, and workflows activity groups. The protocol summary now carries `workspaceId` and `webComposition` as the HTTP summary does.
- Verified: The focused fresh-home sync test, full web lint, typecheck, build, and 621 web tests passed. Core lint, typecheck, build, and Vibe preflight passed after the latest source edits. The focused core and packed-install retests are recorded below when they finish.
- Verified: The packed fresh-home scenario passed after repository sync was changed to skip an absent global mode. An explicitly configured global mode still syncs independently.
- Open: The earlier full packed-install run had 5 failures among 383 tests. The four remaining failed cases and the full suite need a clean rerun before packed-install approval.
- Open: A guard now preserves the installed static web registry when Vite re-evaluates `Providers.tsx`; web lint and typecheck pass. A clean browser hot-reload check remains pending because the concurrent packed fixture builds replaced local artifacts while Vite was running. Per-package generation watching and hot facet replacement are separate open work.
- Open: Full affected-package tests, full browser Playwright, staged desktop E2E, and final packed-install approval have not passed for this change. Per-package generation watching and hot facet replacement are not implemented.

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
- Core test result: 108 files and 1,222 tests passed.
- Coverage: 86.93 percent statements, 80.00 percent branches (5,611 of 7,013), 89.82 percent functions, and 90.27 percent lines.
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
- Native child requests now project standard direct-harness tools, exclusions, required and allowed tool ceilings, resolved skill prompts, and Team intercom without discarding the standard tools.

### Latest checkout-scoped verification

- `pnpm lint:vibe --preflight-only` passed across 3,131 package files after the final edits.
- Sequential uncached affected typecheck and build targets passed.
- The full uncached MCP target passed 23 files and 302 tests.
- The full uncached core target passed 108 files and 1,222 tests with the coverage figures recorded above.
- The uncached core packed-install system target passed 4 files and 382 tests, with 1 platform-specific test skipped.
- The Team suite passed all 76 files and 1,395 assertions. Its aggregate target remains open because branch coverage is 78.20 percent against the 80 percent gate.
- `node ./packages/core/doompi/dist/bin/cli.mjs init`, `node ./packages/core/doompi/dist/bin/cli.mjs sync`, and `node ./packages/core/doompi/dist/bin/cli.mjs sync --check` passed from this checkout in an isolated home. After the native child fix was rebuilt, `sync --check` again reported that the checkout is up to date.
- The affected test sweep remains open. Runtime assertions passed in many packages, but stale package test harnesses still invoke Pi factories without the required composed Cordis host. Voice, Author, Workflow, and package-shape expectations also have isolated cutover mismatches that must be migrated before the repository test gate is accepted.

### Web and desktop

- Web lint and typecheck passed.
- Web Vitest result: 68 files and 629 tests passed.
- The web build now passes uncached after rebuilding its dependencies.
- Desktop package lint, typecheck, build, tests, E2E, and Vibe checks passed.
- Desktop startup stages the core headless executable and the presentation-only web process.

### Repository checks

- Final Vibe preflight and `git diff --check` passed after the latest acceptance edits.
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

- The complete core packed-install system suite passes after the final manifest and build changes. A clean consumer resolves the declared server, Pi, and web artifacts without workspace source access.
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
