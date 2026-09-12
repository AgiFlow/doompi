# Canonical three-surface migration

This document is the architecture and operator guide for DoomPi's three canonical extension surfaces. Current evidence and unresolved release gates are tracked in [migrations_todo.md](./migrations_todo.md).

## Canonical ownership

DoomPi has exactly three extension surfaces:

1. `./extensions/pi` runs inside the Pi terminal. It owns terminal integration and in-process native Team children.
2. `doompiWeb.client` contributes browser presentation code. Browser plugins do not own sessions, APIs, security, or persistence.
3. `./extensions/server`, declared by `doompiServer`, runs in the client-neutral headless process.

The headless process owns the hub, session runtimes, native child services, package APIs, authentication, authorization, history, bounded replay, and event projection. Web and desktop are clients of that process. Explicit Claude and Codex runtimes remain external subprocesses and never fall back automatically to a native runtime.

## Global, workspace, and session mounts

Both server facets and browser contributions declare their supported scopes. Scope is independent of the three extension surfaces above.

| Mount     | Configuration and ownership                                                                      | API prefix                                        |
| --------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Global    | Home `~/.pi/.doom`; one server lifetime, available without sessions                              | `/api/global/plugin/:basePath/*`                  |
| Workspace | Canonical repository or worktree; repository config overlays home config; shared by its sessions | `/api/workspaces/:workspaceId/plugin/:basePath/*` |
| Session   | Workspace defaults plus explicit session overrides; live session UI and APIs                     | `/api/sessions/:sessionId/plugin/:basePath/*`     |

A route resolves only in its named mount. A missing workspace or session handler never falls back to a parent handler. Workspace admission canonicalizes the root and uses its worktree identity. Workspace mounts remain available after their last session closes. Explicit removal rejects workspaces with live sessions, then disposes their APIs, channels, and published browser composition.

Server descriptor version 2 declares `global`, `workspace`, and `session` scopes. Browser manifests declare `doompiWeb.scopes`, and their exported definition has corresponding `global`, `workspace`, and `session` contribution groups. Each group starts and stops with its mount. Session focus changes visibility without stopping other mounted sessions. Visible contributions combine parent and child groups, with matching child contribution keys taking precedence.

The global provider/model API is owned by core. Config settings mount globally for home writes and in workspaces for repository writes. Repository settings writes require the admitted workspace ID and a current file hash. Session file completion and live controls mount on the owning session. Explicit session selection changes override only the selected axis; inherited defaults are re-read at turn admission.

`GET /api/compositions` advertises the global and admitted workspace browser compositions. Session summaries advertise their workspace ID and session composition. Each composition uses a signed, immutable asset snapshot and has its own disposal lifetime. Development verification requires an operator-supplied `VITE_DOOMPI_PLUGIN_PUBLIC_KEY`; production uses the trusted service-worker verification path.

Use checkout-scoped commands:

```sh
node ./packages/core/doompi/dist/bin/cli.mjs sync --global
node ./packages/core/doompi/dist/bin/cli.mjs sync
node ./packages/core/doompi/dist/bin/serve.mjs --auth-token-file /path/to/token --no-session --web 7447
```

Normal repository sync also prepares the global composition. `--no-session` starts global services without admitting a workspace. `POST /api/workspaces` with `{ "root": "/path/to/repository" }` admits a synchronized workspace; `DELETE /api/workspaces/:workspaceId` explicitly removes an unused mount.

When local package code changes without a config or package-version change, use `sync --force` before restarting the headless process. A plain sync may report the package set as current while an older compiled facet remains in the active generation. Keep test runs in a separate Doom home and on separate server and web ports when another cockpit is active.

Automatic replacement of already mounted server generations after a new sync remains an acceptance item. Scope declarations and browser replacement support alone do not establish end-to-end hot reload.

## Server declaration and loading

A package publishes one server facet through its manifest:

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

Sync produces a generation-pinned `server.bundle.json`. The headless host loads only that descriptor and the exact compiled modules it names. Missing, stale, or malformed descriptors fail explicitly. There is no alternate aggregate-module loader and no environment-selected API directory.

The server facet is a Cordis object plugin. It declares its injected services, registers only capabilities allowed by its scope, and returns bounded, idempotent cleanup.

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

A broken required declaration prevents the affected composition from starting. A retained but currently ineligible facet stays mounted without receiving capabilities above its declared ceiling.

## Direct session runtime

Each admitted session owns one in-process direct harness runtime. Typed service calls carry commands into the runtime. Presentation events flow outward through a bounded projection with a maximum of 1,024 retained events.

Prompt admission and model settlement are separate. A caller may wait only for acceptance, while the returned settlement promise records completion or failure. Disposal rejects pending work, withdraws session-owned services, and runs cleanup once.

The browser-facing Pi endpoint is `/api/pi`. It implements the authenticated Pi 0.85 client protocol and isolates every connection to its admitted session and grants. The old command channel and its response-correlation framing are not part of the architecture. Deprecated command endpoints stay unavailable.

Server root sessions and native server children persist their canonical transcript in SQLite. Terminal sessions and terminal-native children keep their Pi-compatible JSONL history. The server reads ordered, cursor-based transcript pages from SQLite and sends only a bounded live tail through the protocol. The browser retains a bounded page window, loads older and newer pages as needed, and virtualizes the timeline. A refresh reconstructs the visible page from SQLite without loading the full conversation. Session usage and context summaries use stored aggregates rather than scanning every transcript entry after each streamed update. Transcript-page and browser render durations are emitted to Log Sink telemetry.

## Native Team children

The Pi terminal and headless session host inject typed child-session services. Native Team children run in process, inherit the allowed composition, and publish lifecycle and presentation events directly. Every child has a separate journal and an explicit capability ceiling. The direct harness projects the standard `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools from the child request, then applies exclusions and the allowed and required tool ceiling. Resolved skill metadata is already part of the child system prompt. Installing Team intercom preserves those projected tools.

Unsupported native child extensions, MCP direct tools, unknown tools, and external profiles fail with a specific error. They do not spawn Pi as a fallback. Explicit Claude and Codex backends continue to use their declared external process adapters.

Child removal is bounded and idempotent. It cancels active work, disposes subscriptions, withdraws projections, and preserves the child's journal according to history policy.

## Package APIs

Author, Voice, computer-use, and other package capabilities receive typed services from the active host. Same-process packages do not rediscover each other through local network endpoints, process registries, token files, or filesystem polling.

Server APIs and their authorization policy are mounted by the server facet that owns them. API calls cannot exceed the caller's session, package, or capability grant. Browser code sees only the client contribution and authenticated public API surface.

## Web and desktop

`doompi-web` serves the browser assets and proxies `/api` plus `/api/pi` to the headless process. It is presentation-only and can be replaced without changing session ownership.

Desktop starts two explicit roles:

- `doompi-server`, the authenticated client-neutral headless owner
- `doompi-web`, the presentation server

Desktop computer-use remains an explicit typed IPC capability. If the desktop host is unavailable, the capability fails rather than selecting another host.

The core headless process must build and run without `doompi-web`, React, or browser assets.

## Security and isolation

Authentication is required before session discovery, control, API access, or replay. Authorization is checked at the headless boundary and again by package-owned APIs where required.

A client can observe and control only its admitted session and granted hub capabilities. Replay is bounded and ordered. Malformed controls, invalid sealed messages, unknown sessions, and cross-session requests fail closed.

Federation is separate from human-device authentication. It remains default-disabled and requires host-local enrollment, confirmed peer fingerprints, revocable credentials, and exact per-agent grants. Peer credentials never grant session creation or human-device APIs.

## History migration boundary

Existing v3 history is never upgraded during normal startup. Stop Pi and every writer first, then run:

```sh
doompi history-import <v3-source> <v4-destination> --confirm-offline
```

Import preserves a byte-exact original and publishes a distinct v4 journal while holding cooperative source and destination leases. A recorded process identifier does not prove that an unmanaged writer stopped. Ambiguous locks are never reclaimed automatically.

For a server-owned SQLite destination, choose the format explicitly while all writers are stopped:

```sh
node ./packages/core/doompi/dist/bin/cli.mjs history-import <v3-or-v4-source> <sqlite-destination> --format sqlite --confirm-offline
```

This is an offline import. Opening a server session does not silently convert a JSONL history file.

If import or export reports an ambiguous lock, preserve the history, lock, and migration-state files. Independently prove that every writer stopped before explicitly archiving or removing a stale lock. If provenance or quiescence cannot be proved, leave the files untouched for manual investigation.

Use this command for a derived Pi-compatible history:

```sh
doompi history-export <v4-source> <v3-destination>
```

Continue that derived file with pinned Pi 0.85.1 using `pi --session <v3-destination>`, or select it in `/resume`. Continuing an export never merges changes into canonical v4 history, and a modified continuation cannot be overwritten by another export.

## Release verification

For every affected release candidate:

1. Run `pnpm vibe-lint check --rules-only <paths>` before governed edits.
2. Format changed files with the repository formatter.
3. Run `pnpm lint:vibe --preflight-only`.
4. Run affected Nx lint, typecheck, build, and test targets sequentially with the Nx cache disabled.
5. Run packed-install system tests.
6. Exercise browser and desktop against an authenticated headless process.
7. Run native execution on `darwin-arm64`, `linux-x64`, and `linux-arm64`.
8. Run `git diff --check` and retain the commands, platform, commit identity, results, and artifacts.

Intel Mac and Windows are outside this migration's approved release targets. Static source inspection and successful compilation do not substitute for runtime acceptance.
