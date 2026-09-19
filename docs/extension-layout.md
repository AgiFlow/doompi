# Extension layout

[Back to DoomPi](../README.md)

DoomPi extensions use folders as their registry. A file's path tells the build what it contributes, where it lives, and which host should load it. Packages do not maintain a second list by hand. [Extension lifecycles](lifecycles.md) explains what happens after these contributions mount.

`@agimon-ai/doompi-build` reads the tree and generates each host entry. It rejects legacy catch-all entries and implementation roots instead of quietly carrying them forward.

## Borrow, do not invent

The convention should feel familiar if you know mainstream full-stack frameworks. DoomPi borrows existing patterns instead of inventing new syntax. When there is no exact match, it uses the closest widely known precedent.

| Mechanism                                   | Borrowed from                                       |
| ------------------------------------------- | --------------------------------------------------- |
| `(group)` folders, invisible to the path    | Next.js App Router route groups                     |
| `_folder`, excluded from routing            | Next.js private folders                             |
| `[param]`, `[...slug]` dynamic segments     | Next.js                                             |
| `route.server.ts` as an HTTP route leaf     | Next.js Route Handlers                              |
| A directory per kind, filename is identity  | Nuxt (`server/api/`, `components/`, `composables/`) |
| `.web.tsx` and `.ios.tsx` platform suffixes | Expo and Metro                                      |

Next.js has no analogue for plugin contributions that are not routes, so tools, tabs and fills follow Nuxt's directory-per-kind model. Everything with a URL follows Next.js exactly.

## The shape

A routed path has four axes:

```text
src/extensions/<scope>/(side)/<surface>/<name>[.<target>][.<platform>].<ext>
       axis 1     axis 1  axis 2   axis 3          axis 4
```

The routing root defaults to `src/extensions`, which is already a canonical source root. `src/extension` is accepted as an alias.

## Prefixes

| Prefix     | Meaning                                                 | Contents scanned |
| ---------- | ------------------------------------------------------- | ---------------- |
| `(name)/`  | Group. Organisational only, invisible to the path.      | yes              |
| `_name/`   | Private. Colocation. Never a contribution, never built. | no               |
| `[param]/` | Dynamic segment. Only inside `api/`.                    | yes              |

`(backend)` and `(frontend)` are reserved because they select the build side. Packages may add organizational groups such as `(admin)` without changing the output path.

Colocation needs no file-level marker, because each half of the tree already excludes non-contributions:

```text
(backend)/api/current/route.server.ts         a route
(backend)/api/current/validate.ts             colocated. only route.server.ts is a route
(frontend)/tab/PlanPanel.web.tsx              a tab
(frontend)/tab/_components/PlanRow.tsx        colocated. _folder is never scanned
```

`*.test.*`, `*.spec.*` and `*.stories.*` are excluded everywhere. A folder at a scannable level that is neither a known surface, a group, nor private produces a notice rather than silence, because a typo that silently contributes nothing is expensive to find.

## Axis 1: scope is folder nesting

```text
src/extensions/                       global      /api/plugins/<id>/...
src/extensions/workspaces/            workspace   /api/workspaces/{w}/plugins/<id>/...
src/extensions/workspaces/sessions/   session     /api/workspaces/{w}/sessions/{s}/plugins/<id>/...
```

These paths name the owner of a feature. Put machine-wide settings and plugin settings directly under `extensions/`, repository settings under `workspaces/`, and Pi commands, tools, hooks, and TUI views for the active agent under `workspaces/sessions/`. The host supplies `workspaceId` and `sessionId`; a routed file does not encode either id.

The hosts use those paths differently. Pi has one extension mount per process, so the generator gathers its routed files into one Pi declaration; the session path describes ownership, not an additional Pi mount. The server has independent global, workspace, and session facets. Its generator repeats broader declarations into narrower facets, while a session file stays in the session facet. The browser merges broader contributions into narrower scopes when it mounts the cockpit. See [Extension lifecycles](lifecycles.md) for the runtime semantics.

## Axis 2: side is `(backend)` or `(frontend)`

Neither appears in any URL. The split is not cosmetic; it is a boundary three mechanisms already need and currently approximate with a hardcoded path.

| Concern         | Without the split                                                                                       | With it                         |
| --------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------- |
| tsconfig        | root excludes `src/web` and the literal `src/extensions/web.ts`, browser config re-includes three paths | one glob each way               |
| Import boundary | the browser allowlist is pinned to one literal file path                                                | the rule matches the whole side |
| Published files | `files` lists web source paths by hand, because web ships as source and backend as dist                 | derived                         |

The sides separate logic from presentation. They do not name a host or an owner. A `.cli.ts` frontend file can render the Pi terminal, while a `.web.tsx` frontend file can render the browser. Browser code must not import backend code.

There are two narrow CLI exceptions. A session command may import a session frontend `overlay/*.cli.ts` route, or a private helper beside it, to open a TUI view. The session Pi root may import a private overlay helper to mount terminal status. Lint rejects other cross-side imports. Put shared data contracts in `src/types`, `src/constants`, `src/schemas`, or the generated API contract.

Each side has its own platform suffixes: `cli` and `server` inside `(backend)`, and `cli`, `web`, `ios`, `android`, or `desktop` inside `(frontend)`. Every public routed file must name one. The scanner still parses an unsuffixed file so it can report a useful notice, but relying on the side to infer a host is not valid authored layout. Files inside a `_folder` are private, so they do not need a platform suffix.

```text
(backend)/tool/write-plan.cli.ts       CLI only
(backend)/tool/write-plan.server.ts    server only
(frontend)/tool/write-plan.web.tsx     that tool's renderer in the browser
(frontend)/tool/write-plan.ios.tsx     iOS override. no iOS build target yet, so no host builds it
```

Matching names across the two sides are the join, and the platform suffix is not part of the name. `(backend)/channel/tasks.server.ts` and `(frontend)/channel/tasks.web.ts` are one frame type. `(backend)/tool/write-plan.server.ts` and `(frontend)/tool/write-plan.web.tsx` are one tool and its renderer.

## Axis 3: surface is the folder

A directory per kind, filename is identity.

| Surface                                     | `(backend)` produces                   | `(frontend)` produces                |
| ------------------------------------------- | -------------------------------------- | ------------------------------------ |
| `tool/`                                     | `tools` on CLI and server              | CLI renderers or web `toolRenderers` |
| `tool-restriction/`                         | tool restrictions                      | not scanned                          |
| `command/`                                  | `commands` on CLI and server           | web `paletteCommands`                |
| `shortcut/`                                 | CLI shortcuts                          | not scanned                          |
| `hook/`                                     | CLI `events`, server `hooks`           | not scanned                          |
| `mode/<id>/mode.*`                          | server `minorModes`                    | web `minorModes`                     |
| `provider/`                                 | CLI providers                          | not scanned                          |
| `api/`                                      | server HTTP routes                     | generated typed client               |
| `channel/`                                  | `channels`, filename is the frame type | web `channels`                       |
| `method/`                                   | server `methods`                       | generated typed caller               |
| `resource/`                                 | CLI and server resources               | not scanned                          |
| `message/`                                  | not scanned                            | CLI message renderers                |
| `tab/`, `dock/`                             | not scanned                            | web tabs and dock faces              |
| `setting/`                                  | not scanned                            | web settings sections or panels      |
| `slot/`, `fill/`                            | not scanned                            | web slots and fills                  |
| `action/`                                   | not scanned                            | web context or user-message actions  |
| `store/`                                    | not scanned                            | a web store at the folder's scope    |
| `overlay/`                                  | not scanned                            | CLI TUI view opened on demand        |
| `activity-group/`, `leader/`                | not scanned                            | web cockpit contributions            |
| `selection-axis/`, `lifecycle/`             | not scanned                            | web singleton or named contributions |
| `file-links/`, `repository-settings-panel/` | not scanned                            | web host integration                 |

The backend scope root owns service injection and startup work. It returns Cordis `services` and, for a server session, host `activities` alongside shared state and cleanup hooks. A server activity can bind session intercom or report suspended runs. It is unrelated to the browser's `activity` slot or `activity-group/` surface.

A frontend `overlay/*.cli.ts` file owns the interactive view that a session command opens through Pi's `ui.custom`. Pi has no overlay registration array.

### Gates are container folders

A gate folder wraps the surfaces it gates.

```text
(backend)/tool/write-plan.server.ts                 always available on the server
(backend)/mode/plan/tool/write-plan.server.ts       only while minor mode `plan` is active
(backend)/mode/plan/mode.server.ts                  the mode declaration
(backend)/domain/billing/tool/invoice.server.ts     only inside domain `billing`
```

The same gate uses different host mechanics. The headless kernel reads a server tool's `when` field. Pi has no matching `when`, so the CLI adapter turns the gate into a restriction in the tool-surface service. Authors use the same folder rule either way.

## Axis 4: target is the filename grammar

```text
{name}[.{target}][.{platform}].{ext}
```

`{name}` is the first segment and is the contribution's identity. `{target}` appears only where the surface is relationship-bearing. `{platform}` is a closed set scoped to the side. Parsing runs right to left, so a dotted slot name stays unambiguous.

```text
fill/PlanRef.task.detail.web.tsx          fills plugin slot `task.detail`
fill/PlanSummary.activity.web.tsx         fills the host activity region
fill/PlanSection.activity.plan.web.tsx    fills activity group `plan`
slot/actions.web.ts                       declares slot `<thisPluginId>.actions`
hook/session-start.cli.ts                 CLI `events.session_start`
hook/session-start.server.ts              server hook `session_start`
tool/write-plan.server.ts                 tool `write_plan`
```

The most specific match wins. A host quietly skips surfaces it does not read, so a routed file reaches only the host named by its platform suffix.

**Filename is identity, and the platform is not part of it.** `(backend)/tool/write-plan.server.ts` declares tool `write_plan` and `(frontend)/tool/write-plan.web.tsx` renders it. This removes the cross-target strings an author matches by hand today: tool names, channel frame types, and status keys. A declaration may still pass an explicit name to keep a legacy identifier.

### One `fill/` folder, one rule

Every fill names a slot, and there is no host-region special case. The cockpit declares its own regions as real slots (`overlay`, `rail`, `context`, `selection-bar`, `activity`, `composer-actions`, `composer-menu`), and an activity group opens `activity.<group>`. So filling a host region and filling another plugin's slot are the same operation, spelled the same way.

```text
fill/PlanRail.rail.web.tsx                 -> { slot: 'rail', id: 'plan-rail' }
fill/PlanSection.activity.plan.web.tsx     -> { slot: 'activity.plan', id: 'plan-section' }
fill/PlanRef.task.detail.web.tsx           -> { slot: 'task.detail', id: 'plan-ref' }
```

The build does not need a list of slot names. A layout package can declare a new region and extensions can fill it without a toolchain change. A fill that names no installed slot becomes an install diagnostic, not a failure.

The older cockpit arrays (`overlays`, `railSections`, `contextSections`, `selectionBarItems`, `composerActions`, `composerMenuItems`, `activitySections`) remain as sugar over the same registry. Generated entries do not use them.

## A worked tree

```text
src/extensions/                                      GLOBAL
  (backend)/api/billing/route.server.ts              /api/plugins/billing
  (backend)/channel/presence.server.ts               hub-lifecycle channel
  (frontend)/setting/account.web.tsx                 global settings page
  (frontend)/fill/AccountBadge.top-bar.web.tsx       global UI region
  (frontend)/store/account.web.ts                    defineGlobalStore

  workspaces/                                        WORKSPACE
    (backend)/api/billing/repos/route.server.ts      /api/workspaces/{w}/plugins/billing/repos
    (frontend)/setting/plan.web.tsx                  workspace settings page
    (frontend)/store/repos.web.ts                    defineWorkspaceStore

    sessions/                                        SESSION
      (backend)/api/current/route.server.ts
      (backend)/tool/write-plan.server.ts
      (backend)/channel/tasks.server.ts
      (frontend)/tab/PlanPanel.web.tsx
      (frontend)/tool/write-plan.web.tsx
      (frontend)/channel/tasks.web.ts
      (frontend)/store/tasks.web.ts                  defineSessionStore

```

## Transports

Three, not four. SSE is not its own mechanism.

**HTTP, including SSE.** A backend `api/` tree follows the familiar folder path and `route.server.ts` leaf convention. The first folder below `api/` is the mount's base path, and the folders below it form the route. The leaf default-exports one `defineRoute(...)` declaration. Put request parsing, handlers, lifecycle, and public symbols in `src/services`, shared contracts, or a private colocated module.

The base path is a folder rather than a constant because it used to be a constant, restated in the contract and again in every URL the browser built, and the copies drifted. Two packages still mount a base path their folder does not name.

**The frontend consumes a generated client.** A package declaring its routes as plain data in `src/types/apiRoutes.ts` gets `generated/client.ts`, into which the build injects the base path and the scopes the tree mounts at. A `(frontend)` file calls `api.session(sessionId).detail({ query })` and never spells a URL.

```ts
// src/types/apiRoutes.ts: no scope or base path, because the build reads them from the tree.
export default defineApiRoutes({
  detail: { method: 'GET', path: '/detail', query: ['path'], response: apiResponse<DetailView>() },
  logStream: { method: 'GET', path: '/log/stream', stream: true },
});
```

A `stream: true` route gets a URL and no call method: its consumer is the browser's own `EventSource`, and a sealed remote session refuses event streams outright.

```text
(backend)/api/runner/current/route.server.ts                    /plugins/runner/current
(backend)/api/runner/runners/[runId]/log/route.server.ts        /plugins/runner/runners/{runId}/log
(backend)/api/runner/runners/[runId]/log/stream/route.server.ts /plugins/runner/runners/{runId}/log/stream
```

An event stream is the same route returning `text/event-stream`, declared in the contract with an events schema map.

**WebSocket.** No extension opens a socket. The host owns the workspace and session sockets, and extensions put frames on them as channels: a hub channel on the backend, a session channel contribution on the frontend. The channel lifecycle comes from the scope folder rather than a field.

**Typed RPC.** `(backend)/method/<member>.server.ts` becomes a server method, with the service defaulting to the plugin id.

All three already live in one API contract document, where the HTTP list covers HTTP and SSE and the socket list covers channels and methods. The generator emits that contract from the tree, and `(frontend)` consumes the generated client instead of hand-writing fetches.

## Shared state

| Scope     | Helper                           |
| --------- | -------------------------------- |
| global    | `defineGlobalStore<T>(initial)`  |
| workspace | `defineWorkspaceStore<T>(empty)` |
| session   | `defineSessionStore<T>(empty)`   |

A session store binds a channel directly: given a channel name, a parse gate and a reducer, it returns a contribution with apply and drop already wired.

```text
(backend)/channel/tasks.server.ts    the hub channel, publishing through the direct event bus
        |
        v                            the hub pushes the frame down the workspace or session socket
(frontend)/channel/tasks.web.ts      the store's channel binding
        |
        v
(frontend)/store/tasks.web.ts        defineSessionStore, read with useStore
```

Inside one process, a route hands data to a channel over the direct event bus with no socket round trip. Across extensions, state is shared through Cordis services and nowhere else: one publishes, another injects by name. That is what keeps composition working, because no extension imports another and any of them may be absent at the next sync.

## How context reaches a routed file

A parameter, never ambient. Both existing helpers already take a factory, and the repository lints against ambient host access.

Every routed file exports a declaration or a factory of one, and the factory receives a mount context narrowed by its folder position.

| Position                                | Adds                                     |
| --------------------------------------- | ---------------------------------------- |
| `src/extensions/**`                     | `scope`, `signal`, the Cordis context    |
| `src/extensions/workspaces/**`          | `workspaceId`, `workspaceRoot`           |
| `src/extensions/workspaces/sessions/**` | `sessionId`, `cwd`, `agent`              |
| `(backend)/*.cli.ts`                    | the Pi extension API and runtime         |
| `(backend)/*.server.ts`                 | the server host service                  |
| `(frontend)/*.web.tsx`                  | the web plugin runtime, no Cordis        |
| `(frontend)/overlay/*.cli.ts`           | Pi's TUI context when a command opens it |

None of these fields are new. The convention narrows an existing union by path instead of handing every file the same wide bag.

**Mount context and invocation context are different.** The factory parameter resolves once when the mount starts. Per call, a handler additionally receives its own: a tool execution context for a tool, the request context for a route.

**Services stay context-free.** Modules under `src/services/**` take dependencies as parameters and know nothing about mounts. The routed file is the composition root that reads the mount context and constructs them.

## No catch-all entries

Use a standard named surface for every contribution. Shared mount state and lifecycle belong in `root.cli.ts` or `root.server.ts`.

A tool override stays in `tool/`, because from the author's side both values mean that the package provides the named tool:

```text
(backend)/tool/grep.cli.ts       definePiTool(tool, { overrides: true })
(backend)/tool/grep.server.ts    defineServerTool(tool)
```

The generated CLI entry splits additions and override claims at runtime.

## The export is typed, not free form

Every scanned file directly default-exports exactly one typed `define*` declaration. It has no named exports and no freeform implementation. Public symbols and shared logic belong in `src/exports`, `src/services`, shared contract roots, or a private `_lib` or `_components` directory.

```ts
// (backend)/tool/write-plan.server.ts
import { defineTool } from '@agimon-ai/doompi-core/extension-file';

export default defineTool((context) => ({
  description: 'Write the plan',
  parameters: WritePlanSchema,
  async execute(input, execution) {
    /* delegate to a service */
  },
}));
```

Backend helpers come from `@agimon-ai/doompi-core/extension-file`; frontend helpers come from `@agimon-ai/doompi-core/web`. Derived identity keys remain optional because an explicit legacy identity may win. Backend helpers accept either a declaration or a mount-context factory. Frontend declarations remain data because the cockpit starts them separately.

Portable and native tools use different helpers. `defineTool` marks a portable declaration for host adaptation. `defineServerTool` and `defineCliTool` preserve native host contracts.

### Cardinality

A standard route contributes one value unless it explicitly says otherwise. Cardinality is helper metadata, never a pseudo-surface folder:

```ts
export default defineRoutedContribution(defineProvider(discoverProviders), { cardinality: 'many' });
export default defineRoutedContribution(optionalHook, { cardinality: 'optional' });
export default defineRoutedContribution(liveTools, { cardinality: 'collection' });
```

`optional` means zero or one, `many` means zero to many, and `collection` preserves a live collection contract such as `PiToolCollection`. Do not create `hook-optional/`, `resource-catalog/`, `tool-collection/`, or equivalent renamed aggregates. Resolve asynchronous discovery in an awaited root, then expose synchronous root-owned values to routes.

Root-owned services are Cordis plugins. The generator reads them before it builds deferred tools, commands, and other registrations.

## The generated entries live outside src

`src` is authored code. The build writes the three host entries to `generated/` at the package root instead, and the package gitignores that directory.

```text
generated/pi.ts       built to dist/extensions/pi.mjs, named by pi.extensions
generated/server.ts   built to dist/extensions/server.mjs, named by doompiServer
generated/web.ts      shipped as source, named by doompiWeb.client
```

These files are generated and gitignored. Do not review or hand-edit them; the next build overwrites them. The formatter also skips `generated/`, so generated output does not dirty the tree.

They still have to reach a consumer. `files` lists `generated/web.ts`, which is the one entry that ships as source for the cockpit to compile, and every Nx target that reads any of them depends on `^build`.

One consequence worth knowing: the cockpit points Tailwind at a plugin's `src/extensions` when it exists, and falls back to a legacy `src/web` root or, failing that, the generated entry's own directory. The routing root comes first because `existsSync` is true for a half-emptied `src/web` that holds nothing but a tsconfig, and scanning that hands Tailwind a directory with no components in it and silently drops every class.

## Colocation

A `_folder` is never scanned, at any depth, so implementation can sit next to the contribution that uses it. Prefer that over a distant shared root whenever exactly one surface uses the code.

```text
(backend)/tool/write-plan.server.ts       the contribution
(backend)/tool/_lib/parse.ts               used only by it
(backend)/_services/telemetry.ts           shared across this side, still not a contribution
(frontend)/tab/PlanPanel.web.tsx           the contribution
(frontend)/tab/_components/PlanRow.tsx     used only by it
_shared/format.ts                          shared across both sides
```

Inside `api/`, colocation needs no underscore at all: only `route.server.ts` is a route, so `api/plan/validate.ts` is already private.

Terminal presentation follows the same rule: `overlay/fleet.cli.ts` owns the TUI view, `overlay/_lib/fleetTranscript.ts` belongs beside it, `message/subagent-notify.cli.ts` owns its message renderer, and `tool/subagent.cli.ts` supplies the Pi tool's renderers. These files stay at the session frontend scope instead of a separate `src/tui` root.

Do not use `src/tui` for a package's own presentation. It remains valid only for packages that publish terminal primitives for other packages to render, where it is a public surface re-exported through `src/exports`. The useful test is who renders the code: your own routed file, or somebody else's.

Private helpers in `_lib` or `_internal` remain beside the routed file that uses them. Service injection and lifecycle cleanup belong in the scope root.

The rule of thumb: shared across surfaces goes to the implementation roots below, used by one surface goes in a `_folder` beside it.

## What does not move

- `src/prompts/<skill>/SKILL.md` stays. It is already a folder convention and a published path named by `llms.txt`. The generator derives the resource contributions from it.
- `src/services` holds platform-agnostic behavior. `src/schemas`, `src/types`, and `src/constants` hold shared contracts. Host registration and host-specific handlers live in routed files. A colocated `_folder` holds code shared by several files in one surface.

`src/web` does move. Browser presentation colocates with the routed `(frontend)` file that renders it, in a `_components` folder for components and a `_lib` folder for everything else, and no extension package keeps a `src/web` root. The cockpit host and the core packages that publish a browser contract keep theirs, because those are published surfaces rather than one package's own presentation.

## Toolchain constraints

Parenthesised directory names are safe across oxlint, oxfmt, TypeScript `include` and `exclude`, the boundary matcher, Vite and rolldown, `npm pack` and `pnpm pack`, and Vitest. Two rules keep them that way.

1. **Never spell a paren directory in a picomatch pattern.** tsdown's globber treats a bare `(...)` as an extglob group, so a pattern naming the directory matches nothing. Reach the same files through `**`. The build tooling derives entries from a filesystem walk rather than a glob, so this stays latent by construction.
2. **Nx globs cannot target a side folder.** Nx's native matcher has no working spelling. Nothing in the layout needs one, but it forecloses an Nx named input that mentions a side.

See [Extension lifecycles](lifecycles.md) for what happens to these contributions once mounted, and [Architecture](architecture.md) for how a package becomes part of a composition.
